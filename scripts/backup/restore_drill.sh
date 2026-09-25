#!/usr/bin/env bash
# F0 restore drill — backup, restore and verify the `rizoma` database.
#
# Proves exit criterion F0 #4 ("restore drill ejecutado y documentado"):
#   1. pg_dump the `rizoma` database (migrations 001 + 002 applied) to
#      /tmp/rizoma-f0-<utc-timestamp>.dump
#   2. create a scratch database `rizoma_restore_f0_<utc-timestamp>`
#   3. restore the dump into it
#   4. verify the restored schema: 22 core tenant_isolation policies,
#      >=1 tenant_isolation policy on onboarding_acta, and schema_migrations
#      holding 001_core_foundation + 002_onboarding
#   5. drop the scratch database and (unless KEEP_DUMP=1) remove the dump
#
# Prints DRILL OK on success and exits non-zero otherwise.
#
# Dependencies: psql, and either the server's pg_dump (preferred: same major
# version as Postgres 16, run inside the compose container) or the host pg_dump.
#
# Usage:  bash scripts/backup/restore_drill.sh
# Env overrides:
#   POSTGRES_* , PG_HOST, PG_CONTAINER (container name, or "host" to force the
#   host pg_dump), KEEP_DUMP=1, EXPECTED_CORE_POLICIES, CURL_TIMEOUT.
set -euo pipefail

export LC_ALL=C

# --- config (defaults match infra/docker/.env.example) ---
PG_HOST=${PG_HOST:-127.0.0.1}
POSTGRES_PORT=${POSTGRES_PORT:-5432}
POSTGRES_USER=${POSTGRES_USER:-rizoma}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-rizoma_demo_password}
POSTGRES_DB=${POSTGRES_DB:-rizoma}

TS=$(date -u +%Y%m%d%H%M%S)
DUMP_FILE=${DUMP_FILE:-/tmp/rizoma-f0-$TS.dump}
RESTORE_DB=${RESTORE_DB:-rizoma_restore_f0_$TS}
KEEP_DUMP=${KEEP_DUMP:-0}
EXPECTED_CORE_POLICIES=${EXPECTED_CORE_POLICIES:-22}
PG_CONTAINER=${PG_CONTAINER:-}

restore_created=0

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR $*"; exit 1; }

# --- client resolution ------------------------------------------------------
postgres_container() {
  [ -n "$PG_CONTAINER" ] && [ "$PG_CONTAINER" != "host" ] && { printf '%s' "$PG_CONTAINER"; return 0; }
  command -v docker >/dev/null 2>&1 || return 1
  docker ps --filter label=com.docker.compose.service=postgres \
    --format '{{.Names}}' 2>/dev/null | head -n1
}

psql_admin() { # <database> [psql args...]
  local db=$1
  shift
  if command -v psql >/dev/null 2>&1; then
    PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$PG_HOST" -p "$POSTGRES_PORT" \
      -U "$POSTGRES_USER" -d "$db" "$@"
    return $?
  fi
  local c
  c=$(postgres_container) || return 127
  [ -n "$c" ] || return 127
  docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$c" \
    psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$db" "$@"
}

sql_scalar() { # <database> <sql>
  psql_admin "$1" -tAc "$2" | tr -d '[:space:]'
}

cleanup() {
  local rc=$?
  if [ "$restore_created" = 1 ]; then
    if psql_admin postgres -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE IF EXISTS \"$RESTORE_DB\" WITH (FORCE);" >/dev/null 2>&1; then
      log "dropped restore database $RESTORE_DB"
    else
      log "WARN could not drop restore database $RESTORE_DB (drop it manually)"
    fi
  fi
  if [ "$KEEP_DUMP" = "1" ]; then
    log "dump kept at $DUMP_FILE"
  elif [ -f "$DUMP_FILE" ]; then
    rm -f -- "$DUMP_FILE"
    log "dump removed: $DUMP_FILE"
  fi
  exit "$rc"
}
trap cleanup EXIT

# --- preconditions ----------------------------------------------------------
command -v psql >/dev/null 2>&1 || [ -n "$(postgres_container || true)" ] \
  || die "psql is required (host client or a running postgres container)"

log "restore drill start — source=$POSTGRES_DB target=$RESTORE_DB dump=$DUMP_FILE"

applied=$(sql_scalar "$POSTGRES_DB" \
  "SELECT count(*) FROM schema_migrations WHERE version IN ('001_core_foundation','002_onboarding');" \
  2>/dev/null || true)
[ "$applied" = "2" ] || die "source database '$POSTGRES_DB' is missing migrations 001/002 (apply db/migrations first; see db/README.md)"

# --- 1. dump ----------------------------------------------------------------
pg_container=$(postgres_container || true)
if [ -n "$pg_container" ] && [ "$PG_CONTAINER" != "host" ]; then
  log "pg_dump via container $pg_container (matches server major version)"
  docker exec -i "$pg_container" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    > "$DUMP_FILE" || die "pg_dump failed"
else
  command -v pg_dump >/dev/null 2>&1 || die "pg_dump is required"
  log "pg_dump via host client"
  PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h "$PG_HOST" -p "$POSTGRES_PORT" \
    -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f "$DUMP_FILE" || die "pg_dump failed"
fi
dump_bytes=$(wc -c < "$DUMP_FILE" | tr -d '[:space:]')
[ "$dump_bytes" -gt 0 ] || die "dump is empty"
log "dump written: $DUMP_FILE ($dump_bytes bytes)"

# --- 2. create scratch database --------------------------------------------
psql_admin postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$RESTORE_DB\" WITH (FORCE);" \
  -c "CREATE DATABASE \"$RESTORE_DB\";" >/dev/null || die "could not create $RESTORE_DB"
restore_created=1
log "created restore database $RESTORE_DB"

# --- 3. restore -------------------------------------------------------------
psql_admin "$RESTORE_DB" -v ON_ERROR_STOP=1 -f "$DUMP_FILE" \
  || die "restore failed (see psql output above)"
log "restore complete"

# --- 4. verify --------------------------------------------------------------
core_policies=$(sql_scalar "$RESTORE_DB" \
  "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname='tenant_isolation' AND tablename <> 'onboarding_acta';")
acta_policies=$(sql_scalar "$RESTORE_DB" \
  "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname='tenant_isolation' AND tablename = 'onboarding_acta';")
migrations=$(sql_scalar "$RESTORE_DB" \
  "SELECT count(*) FROM schema_migrations WHERE version IN ('001_core_foundation','002_onboarding');")

log "verify core tenant_isolation policies: $core_policies (expected $EXPECTED_CORE_POLICIES)"
log "verify onboarding_acta tenant_isolation policies: $acta_policies (expected >= 1)"
log "verify schema_migrations 001+002: $migrations (expected 2)"

[ "$core_policies" = "$EXPECTED_CORE_POLICIES" ] \
  || die "core tenant_isolation policy count mismatch"
[ "${acta_policies:-0}" -ge 1 ] || die "onboarding_acta has no tenant_isolation policy"
[ "$migrations" = "2" ] || die "schema_migrations does not contain 001+002"

# --- evidence summary -------------------------------------------------------
log "evidence — date=$(date -u +%Y-%m-%dT%H:%M:%SZ) dump_bytes=$dump_bytes db=$RESTORE_DB core_policies=$core_policies acta_policies=$acta_policies migrations=$migrations"
log "DRILL OK"
