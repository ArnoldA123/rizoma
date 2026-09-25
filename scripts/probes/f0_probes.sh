#!/usr/bin/env bash
# F0 synthetic probes — exit-criteria smoke checks for the local stack.
#
# Read-only checks over the loopback-only F0 services:
#   postgres   pg_isready + SELECT 1 (direct 5432 and via PgBouncer 6432)
#   redis      PING + key roundtrip
#   keycloak   management /health/ready (9000) and realm /realms/master (8080)
#   s3         LocalStack /_localstack/health (4566)
#
# Dependencies: psql/pg_isready, curl and (as a fallback when the host client
# binary is missing) docker. No npm packages, no dependency installs, no
# traffic beyond 127.0.0.1.
#
# Every probe prints PASS/FAIL with a UTC timestamp. The script exits 1 if any
# probe fails, so it can gate CI or a release checklist.
#
# Usage:  bash scripts/probes/f0_probes.sh
# Overrides: POSTGRES_*, PGBOUNCER_PORT, REDIS_*, KEYCLOAK_*, S3_*, CURL_TIMEOUT.
set -uo pipefail

export LC_ALL=C

# --- config (defaults match infra/docker/.env.example) ---
PG_HOST=${PG_HOST:-127.0.0.1}
POSTGRES_PORT=${POSTGRES_PORT:-5432}
PGBOUNCER_PORT=${PGBOUNCER_PORT:-6432}
POSTGRES_USER=${POSTGRES_USER:-rizoma}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-rizoma_demo_password}
POSTGRES_DB=${POSTGRES_DB:-rizoma}

REDIS_HOST=${REDIS_HOST:-127.0.0.1}
REDIS_PORT=${REDIS_PORT:-6379}
REDIS_PASSWORD=${REDIS_PASSWORD:-rizoma_demo_password}
REDIS_CONTAINER=${REDIS_CONTAINER:-}

KEYCLOAK_HOST=${KEYCLOAK_HOST:-127.0.0.1}
KEYCLOAK_PORT=${KEYCLOAK_PORT:-8080}
KEYCLOAK_MANAGEMENT_PORT=${KEYCLOAK_MANAGEMENT_PORT:-9000}

S3_HOST=${S3_HOST:-127.0.0.1}
S3_PORT=${S3_PORT:-4566}

CURL_TIMEOUT=${CURL_TIMEOUT:-5}

pass=0
fail=0

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

probe() { # <name> <command...>
  local name=$1
  shift
  if "$@" >/dev/null 2>&1; then
    printf '[%s] PASS %s\n' "$(now)" "$name"
    pass=$((pass + 1))
  else
    printf '[%s] FAIL %s\n' "$(now)" "$name"
    fail=$((fail + 1))
  fi
}

# --- client resolution ------------------------------------------------------
# Prefer the host binary; fall back to the matching container so the probe can
# still run on a workstation without the Postgres/Redis clients installed.

postgres_container() {
  [ -n "${PG_CONTAINER:-}" ] && { printf '%s' "$PG_CONTAINER"; return 0; }
  command -v docker >/dev/null 2>&1 || return 1
  docker ps --filter label=com.docker.compose.service=postgres \
    --format '{{.Names}}' 2>/dev/null | head -n1
}

redis_container() {
  [ -n "$REDIS_CONTAINER" ] && { printf '%s' "$REDIS_CONTAINER"; return 0; }
  command -v docker >/dev/null 2>&1 || return 1
  docker ps --filter label=com.docker.compose.service=redis \
    --format '{{.Names}}' 2>/dev/null | head -n1
}

pg_isready_check() { # <port>
  local port=$1
  if command -v pg_isready >/dev/null 2>&1; then
    pg_isready -h "$PG_HOST" -p "$port" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      -t "$CURL_TIMEOUT" >/dev/null 2>&1
    return $?
  fi
  local c
  c=$(postgres_container) || return 127
  [ -n "$c" ] || return 127
  docker exec -i "$c" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    >/dev/null 2>&1
}

psql_scalar() { # <port> <sql>
  local port=$1 sql=$2
  if command -v psql >/dev/null 2>&1; then
    PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$PG_HOST" -p "$port" \
      -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$sql" 2>/dev/null
    return $?
  fi
  local c
  c=$(postgres_container) || return 127
  [ -n "$c" ] || return 127
  docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$c" \
    psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$sql" 2>/dev/null
}

select_one_ok() { # <port>
  [ "$(psql_scalar "$1" 'SELECT 1' | tr -d '[:space:]')" = "1" ]
}

redis_cli() { # <args...>
  if [ -n "$REDIS_CONTAINER" ]; then
    docker exec -i -e REDISCLI_AUTH="$REDIS_PASSWORD" "$REDIS_CONTAINER" \
      redis-cli "$@"
    return $?
  fi
  if command -v redis-cli >/dev/null 2>&1; then
    REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" "$@"
    return $?
  fi
  local c
  c=$(redis_container) || return 127
  [ -n "$c" ] || return 127
  docker exec -i -e REDISCLI_AUTH="$REDIS_PASSWORD" "$c" redis-cli "$@"
}

redis_ping_key_ok() {
  local key="f0:probe:$(date +%s):$$" val="probe-ok"
  [ "$(redis_cli PING 2>/dev/null)" = "PONG" ] || return 1
  redis_cli SET "$key" "$val" >/dev/null 2>&1 || return 1
  local got
  got=$(redis_cli GET "$key" 2>/dev/null)
  redis_cli DEL "$key" >/dev/null 2>&1 || true
  [ "$got" = "$val" ]
}

http_status_ok() { # <url> <expected-status>
  local url=$1 want=${2:-200} code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$CURL_TIMEOUT" "$url" 2>/dev/null)
  [ "$code" = "$want" ]
}

s3_health_ok() {
  local url="http://$S3_HOST:$S3_PORT/_localstack/health" body
  body=$(curl -fsS --max-time "$CURL_TIMEOUT" "$url" 2>/dev/null) || return 1
  printf '%s' "$body" | grep -q '"s3"'
}

# --- probes -----------------------------------------------------------------
printf '[%s] F0 probes — local stack smoke checks\n' "$(now)"

probe "postgres:pg_isready:$POSTGRES_PORT"      pg_isready_check "$POSTGRES_PORT"
probe "postgres:select1-direct:$POSTGRES_PORT"  select_one_ok "$POSTGRES_PORT"
probe "postgres:select1-pgbouncer:$PGBOUNCER_PORT" select_one_ok "$PGBOUNCER_PORT"
probe "redis:ping+key-roundtrip:$REDIS_PORT"    redis_ping_key_ok
probe "keycloak:health-ready:$KEYCLOAK_MANAGEMENT_PORT" \
  http_status_ok "http://$KEYCLOAK_HOST:$KEYCLOAK_MANAGEMENT_PORT/health/ready" 200
probe "keycloak:realm-master:$KEYCLOAK_PORT" \
  http_status_ok "http://$KEYCLOAK_HOST:$KEYCLOAK_PORT/realms/master" 200
probe "s3:localstack-health:$S3_PORT"           s3_health_ok

total=$((pass + fail))
if [ "$fail" -eq 0 ]; then
  printf '[%s] F0 PROBES: %d/%d PASS\n' "$(now)" "$pass" "$total"
  exit 0
fi
printf '[%s] F0 PROBES: FAIL (%d/%d, %d failed)\n' "$(now)" "$pass" "$total" "$fail"
exit 1
