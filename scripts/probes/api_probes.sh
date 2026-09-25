#!/usr/bin/env bash
# API runtime probes — end-to-end smoke checks against the local stack.
#
# What it exercises, with a real Keycloak token and the real Postgres:
#   1. boot        builds `@rizoma/api` when `dist` is stale, starts it on a free
#                  31xx port and waits (bounded) for `GET /health` to answer.
#   2. health      `GET /health` -> 200 with `"status":"ok"`.
#   3. auth        no token -> 403 `tenant.missing`; bad token -> 401
#                  `auth.token_invalid`; valid service-account token -> 404
#                  (route absent, i.e. the request was accepted past the guard).
#   4. revocation  inserts an idempotent probe tenant/user/org/membership, reads
#                  a decision through the *real* `loadMembership` (built `dist`
#                  + `pg`), flips `memberships.active = FALSE`, and measures the
#                  wall-clock time until that same decision denies. It also
#                  deactivates the `users` row to prove `users.active` now feeds
#                  `decideAccess`. This is the end-to-end <5-minute revocation
#                  check required by bases-consolidadas-v1.md §3.1 property 5.
#
# Every probe prints PASS/FAIL with a UTC timestamp; the script exits 1 if any
# probe fails. It never touches the Keycloak realm, the migrations, or any other
# module, and it leaves the probe fixtures in place (deactivated, idempotent).
#
# Dependencies: bash, curl, psql (host, else the `rizoma-postgres-1` container,
# as f0_probes.sh does), and node (JSON parsing + the decision script). No npm
# installs, no traffic beyond 127.0.0.1.
#
# Usage:  bash scripts/probes/api_probes.sh   (or: npm run probes:api)
# Env overrides: POSTGRES_*, PG_CONTAINER, REDIS_URL, KEYCLOAK_*, API_HOST,
#                API_PORT_BASE, API_START_TIMEOUT, CURL_TIMEOUT,
#                API_PROBE_SKIP_BUILD=1.
set -uo pipefail

export LC_ALL=C

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
cd "$ROOT" || exit 1

# --- config (defaults match infra/docker/.env.example) ---
PG_HOST=${PG_HOST:-127.0.0.1}
POSTGRES_PORT=${POSTGRES_PORT:-5432}
POSTGRES_USER=${POSTGRES_USER:-rizoma}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-rizoma_demo_password}
POSTGRES_DB=${POSTGRES_DB:-rizoma}

REDIS_URL=${REDIS_URL:-redis://:rizoma_demo_password@localhost:6379}

KEYCLOAK_URL=${KEYCLOAK_URL:-http://127.0.0.1:8080}
KEYCLOAK_REALM=${KEYCLOAK_REALM:-rizoma}
KEYCLOAK_CLIENT_ID=${KEYCLOAK_CLIENT_ID:-rizoma-api}
KEYCLOAK_CLIENT_SECRET=${KEYCLOAK_CLIENT_SECRET:-rizoma_api_demo_secret}

DATABASE_URL=${DATABASE_URL:-postgresql://rizoma:rizoma_demo_password@127.0.0.1:5432/rizoma}
DATABASE_URL_PGBOUNCER=${DATABASE_URL_PGBOUNCER:-postgresql://rizoma:rizoma_demo_password@127.0.0.1:6432/rizoma}

API_HOST=${API_HOST:-127.0.0.1}
API_PORT_BASE=${API_PORT_BASE:-3100}
API_START_TIMEOUT=${API_START_TIMEOUT:-30}
CURL_TIMEOUT=${CURL_TIMEOUT:-5}

# Probe fixtures (fixed ids so every run is idempotent).
TENANT_ID="22222222-2222-4222-8222-222222222222"
ORG_NODE_ID="33333333-3333-4333-8333-333333333333"
REVOKE_USER_ID="44444444-4444-4444-8444-444444444444"
MEMBERSHIP_ID="55555555-5555-4555-8555-555555555555"
PROBE_ACTION="invoice.issue"
REVOCATION_BUDGET_S=300

pass=0
fail=0
rev_seconds="-1"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# Epoch milliseconds from the bash builtin clock; avoids a `date` fork per call
# and the `date +%s%3N` portability trap (some coreutils ignore the width).
clock_ms() {
  if [ -n "${EPOCHREALTIME:-}" ]; then
    local us=${EPOCHREALTIME/./}
    printf '%s' "$((us / 1000))"
    return 0
  fi
  # Fallback (bash < 5): second resolution is enough for the 300s budget.
  printf '%s' "$(( $(date +%s) * 1000 ))"
}

record() { # <ok:0|1> <name> <detail>
  local ok=$1 name=$2 detail=${3:-}
  if [ "$ok" = "0" ]; then
    printf '[%s] PASS %s%s\n' "$(now)" "$name" "$detail"
    pass=$((pass + 1))
  else
    printf '[%s] FAIL %s%s\n' "$(now)" "$name" "$detail"
    fail=$((fail + 1))
  fi
}

json_field() { # <json> <key>
  printf '%s' "$1" | node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      let v = {};
      try { v = JSON.parse(s || "{}"); } catch { v = {}; }
      const out = v[process.argv[1]];
      process.stdout.write(out === undefined || out === null ? "" : String(out));
    });
  ' "$2"
}

# --- client resolution ------------------------------------------------------
postgres_container() {
  [ -n "${PG_CONTAINER:-}" ] && { printf '%s' "$PG_CONTAINER"; return 0; }
  command -v docker >/dev/null 2>&1 || return 1
  docker ps --filter label=com.docker.compose.service=postgres \
    --format '{{.Names}}' 2>/dev/null | head -n1
}

# Reads SQL from stdin, fail-closed on error.
psql_run_sql() {
  if command -v psql >/dev/null 2>&1; then
    PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$PG_HOST" -p "$POSTGRES_PORT" \
      -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -tA -q
    return $?
  fi
  local c
  c=$(postgres_container) || return 127
  [ -n "$c" ] || return 127
  docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$c" \
    psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -tA -q
}

find_free_port() {
  local p base
  base=$API_PORT_BASE
  for p in $(seq "$base" "$((base + 99))"); do
    if ! (exec 3<>"/dev/tcp/$API_HOST/$p") 2>/dev/null; then
      printf '%s' "$p"
      return 0
    fi
  done
  return 1
}

api_log=$(mktemp)
decision_script=$(mktemp "${TMPDIR:-/tmp}/api-probe-decision.XXXXXX.js")
api_pid=""

cleanup() {
  if [ -n "$api_pid" ] && kill -0 "$api_pid" 2>/dev/null; then
    # SIGTERM exercises `enableShutdownHooks` (pool/Redis close) in main.ts.
    kill "$api_pid" 2>/dev/null
    wait "$api_pid" 2>/dev/null
  fi
  rm -f "$api_log" "$decision_script" 2>/dev/null
}
trap cleanup EXIT

printf '[%s] API probes — runtime auth, policy and revocation\n' "$(now)"

# --- 1. build + boot --------------------------------------------------------
DIST_MAIN="$ROOT/apps/api/dist/main.js"
needs_build=0
if [ ! -f "$DIST_MAIN" ]; then
  needs_build=1
elif [ "${API_PROBE_SKIP_BUILD:-0}" != "1" ]; then
  if [ -n "$(find "$ROOT/apps/api/src" -name '*.ts' -newer "$DIST_MAIN" -print -quit 2>/dev/null)" ]; then
    needs_build=1
  fi
fi
if [ "$needs_build" = "1" ]; then
  printf '[%s] building @rizoma/api (dist missing or stale)\n' "$(now)"
  if ! npm run build --workspace @rizoma/api >"$api_log" 2>&1; then
    record 1 "api:build" " (see log below)"
    sed 's/^/    /' "$api_log"
    printf 'API PROBES: 0/0 PASS (build failed)\n'
    exit 1
  fi
fi

API_PORT=$(find_free_port) || { printf 'no free port in %s..%s\n' "$API_PORT_BASE" "$((API_PORT_BASE + 99))"; exit 1; }
API_BASE="http://$API_HOST:$API_PORT"

PORT="$API_PORT" \
DATABASE_URL="$DATABASE_URL" \
DATABASE_URL_PGBOUNCER="$DATABASE_URL_PGBOUNCER" \
REDIS_URL="$REDIS_URL" \
KEYCLOAK_URL="$KEYCLOAK_URL" \
KEYCLOAK_REALM="$KEYCLOAK_REALM" \
  node "$DIST_MAIN" >"$api_log" 2>&1 &
api_pid=$!

api_ready=1
for _ in $(seq 1 "$API_START_TIMEOUT"); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$API_BASE/health" 2>/dev/null)" = "200" ]; then
    api_ready=0
    break
  fi
  if ! kill -0 "$api_pid" 2>/dev/null; then
    api_ready=2
    break
  fi
  sleep 1
done

if [ "$api_ready" != "0" ]; then
  record 1 "api:boot:$API_PORT" " (not ready after ${API_START_TIMEOUT}s)"
  sed 's/^/    /' "$api_log"
  printf 'API PROBES: 0/0 PASS (boot failed)\n'
  exit 1
fi

# --- 2. token ---------------------------------------------------------------
token_response=$(curl -s --max-time "$CURL_TIMEOUT" -X POST \
  "$KEYCLOAK_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=client_credentials' \
  -d "client_id=$KEYCLOAK_CLIENT_ID" \
  -d "client_secret=$KEYCLOAK_CLIENT_SECRET")
ACCESS_TOKEN=$(json_field "$token_response" access_token)

if [ -z "$ACCESS_TOKEN" ]; then
  record 1 "auth:client-credentials-token" " (response: $token_response)"
  printf 'API PROBES: 0/0 PASS (no token)\n'
  exit 1
fi

# --- 3. HTTP probes ---------------------------------------------------------
request() { # <url> [curl args...]  -> body on stdout, status on last line
  curl -s -w $'\n%{http_code}' --max-time "$CURL_TIMEOUT" "$@"
}

status_of() { printf '%s' "${1##*$'\n'}"; }
body_of() { printf '%s' "${1%$'\n'*}"; }

t0=$(clock_ms)
health=$(request "$API_BASE/health")
t1=$(clock_ms)
if [ "$(status_of "$health")" = "200" ] && printf '%s' "$(body_of "$health")" | grep -q '"status":"ok"'; then
  record 0 "api:health-200-ok" " ($((t1 - t0))ms)"
else
  record 1 "api:health-200-ok" " (status=$(status_of "$health") body=$(body_of "$health"))"
fi

t0=$(clock_ms)
missing=$(request "$API_BASE/v1/patients")
t1=$(clock_ms)
if [ "$(status_of "$missing")" = "403" ]; then
  record 0 "auth:no-token-403" " ($((t1 - t0))ms, code=$(json_field "$(body_of "$missing")" code))"
else
  record 1 "auth:no-token-403" " (status=$(status_of "$missing"))"
fi

t0=$(clock_ms)
invalid=$(request -H 'Authorization: Bearer not.a.valid.jwt' "$API_BASE/v1/patients")
t1=$(clock_ms)
if [ "$(status_of "$invalid")" = "401" ]; then
  record 0 "auth:invalid-token-401" " ($((t1 - t0))ms, code=$(json_field "$(body_of "$invalid")" code))"
else
  record 1 "auth:invalid-token-401" " (status=$(status_of "$invalid"))"
fi

t0=$(clock_ms)
valid=$(request -H "Authorization: Bearer $ACCESS_TOKEN" "$API_BASE/v1/patients")
t1=$(clock_ms)
if [ "$(status_of "$valid")" = "404" ]; then
  record 0 "auth:valid-token-accepted-404" " ($((t1 - t0))ms)"
else
  record 1 "auth:valid-token-accepted-404" " (status=$(status_of "$valid") body=$(body_of "$valid"))"
fi

# --- 4. revocation (real loadMembership + real users.active) ----------------
# Decision script: loads the membership through the built `loadMembership`
# (one JOIN query), then runs `decideAccess` with the policy matrix.
cat >"$decision_script" <<'NODE'
const path = require('node:path');
const root = process.env.PROBE_ROOT;
const { loadMembership } = require(path.join(root, 'apps/api/dist/auth/access.guard.js'));
const { decideAccess } = require(path.join(root, 'apps/api/dist/auth/guard.js'));
const { rolePermitsAction } = require(path.join(root, 'apps/api/dist/auth/policy.js'));
const { Client } = require('pg');

(async () => {
  const tenantId = process.env.PROBE_TENANT_ID;
  const userId = process.env.PROBE_USER_ID;
  const action = process.env.PROBE_ACTION;
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenantId]);
    const membership = await loadMembership(client, userId, tenantId);
    if (membership === null) {
      console.log(JSON.stringify({ found: false }));
      return;
    }
    const now = new Date().toISOString();
    const decision = decideAccess({
      userActive: membership.userActive ?? true,
      membershipActive: membership.active,
      now,
      validFrom: membership.validFrom,
      validTo: membership.validTo,
      entityOrgNodeId: membership.orgNodeId,
      scopeSubtree: [membership.orgNodeId],
      rolePermits: rolePermitsAction(membership.role, action),
      stateAllows: true,
      moduleActive: true,
    });
    console.log(JSON.stringify({
      found: true,
      allow: decision.allow,
      reason: decision.reason,
      role: membership.role,
      membershipActive: membership.active,
      userActive: membership.userActive,
    }));
  } finally {
    await client.end();
  }
})().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(3);
});
NODE

read_decision() {
  PROBE_ROOT="$ROOT" \
  PROBE_TENANT_ID="$TENANT_ID" \
  PROBE_USER_ID="$REVOKE_USER_ID" \
  PROBE_ACTION="$PROBE_ACTION" \
  DATABASE_URL="$DATABASE_URL" \
  NODE_PATH="$ROOT/node_modules" \
    node "$decision_script"
}

fixtures_ok=0
# Exact SQL used by the probe (idempotent upsert of the fixture graph):
#   INSERT INTO tenants   (id,name,modules) VALUES (...) ON CONFLICT (id) DO UPDATE SET modules;
#   INSERT INTO org_nodes (id,tenant_id,kind,name,active) VALUES (...) ON CONFLICT (id) DO UPDATE SET active = TRUE;
#   INSERT INTO users     (id,tenant_id,name,email,active) VALUES (...) ON CONFLICT (id) DO UPDATE SET active = TRUE;
#   INSERT INTO memberships (id,user_id,tenant_id,org_node_id,role,scopes,active,valid_from,valid_to)
#     VALUES (...,'caja','{crm-core}',TRUE,now(),NULL)
#     ON CONFLICT (id) DO UPDATE SET active = TRUE, valid_from = now(), valid_to = NULL;
if psql_run_sql <<SQL
INSERT INTO tenants (id, name, modules) VALUES ('$TENANT_ID', 'API probes tenant', '{crm-core}')
  ON CONFLICT (id) DO UPDATE SET modules = EXCLUDED.modules;
INSERT INTO org_nodes (id, tenant_id, kind, name, active)
  VALUES ('$ORG_NODE_ID', '$TENANT_ID', 'sede', 'API probes sede', TRUE)
  ON CONFLICT (id) DO UPDATE SET active = TRUE;
INSERT INTO users (id, tenant_id, name, email, active)
  VALUES ('$REVOKE_USER_ID', '$TENANT_ID', 'API probes user', 'api-probes@rizoma.test', TRUE)
  ON CONFLICT (id) DO UPDATE SET active = TRUE;
INSERT INTO memberships (id, user_id, tenant_id, org_node_id, role, scopes, active, valid_from, valid_to)
  VALUES ('$MEMBERSHIP_ID', '$REVOKE_USER_ID', '$TENANT_ID', '$ORG_NODE_ID', 'caja', '{crm-core}', TRUE, now(), NULL)
  ON CONFLICT (id) DO UPDATE SET active = TRUE, valid_from = now(), valid_to = NULL;
SQL
then
  fixtures_ok=1
fi

if [ "$fixtures_ok" != "1" ]; then
  record 1 "revocation:fixtures" " (psql unavailable or SQL failed)"
else
  before=$(read_decision)
  before_allow=$(json_field "$before" allow)
  if [ "$before_allow" = "true" ] && [ "$(json_field "$before" userActive)" = "true" ]; then
    record 0 "revocation:before-allow" " (reason=$(json_field "$before" reason), userActive=true)"
  else
    record 1 "revocation:before-allow" " (decision=$before)"
  fi

  # Deactivate the membership and measure until the next real read denies.
  start_ms=$(clock_ms)
  psql_run_sql <<SQL
UPDATE memberships SET active = FALSE WHERE id = '$MEMBERSHIP_ID';
SQL
  deadline_ms=$((start_ms + REVOCATION_BUDGET_S * 1000))
  after=""
  while :; do
    after=$(read_decision)
    [ "$(json_field "$after" allow)" = "false" ] && break
    [ "$(clock_ms)" -ge "$deadline_ms" ] && break
    sleep 1
  done
  end_ms=$(clock_ms)
  rev_ms=$((end_ms - start_ms))
  rev_seconds=$(awk "BEGIN { printf \"%.3f\", $rev_ms / 1000 }")

  if [ "$(json_field "$after" allow)" = "false" ]; then
    record 0 "revocation:membership-deactivated-denies" " (reason=$(json_field "$after" reason), ${rev_seconds}s)"
  else
    record 1 "revocation:membership-deactivated-denies" " (decision=$after)"
  fi

  if [ "$rev_ms" -lt $((REVOCATION_BUDGET_S * 1000)) ]; then
    record 0 "revocation:within-${REVOCATION_BUDGET_S}s" " (${rev_seconds}s)"
  else
    record 1 "revocation:within-${REVOCATION_BUDGET_S}s" " (${rev_seconds}s)"
  fi

  # `users.active = FALSE` must now flow into decideAccess through the JOIN.
  psql_run_sql <<SQL
UPDATE memberships SET active = TRUE WHERE id = '$MEMBERSHIP_ID';
UPDATE users SET active = FALSE WHERE id = '$REVOKE_USER_ID';
SQL
  owner_after=$(read_decision)
  if [ "$(json_field "$owner_after" allow)" = "false" ] && [ "$(json_field "$owner_after" reason)" = "user.inactive" ]; then
    record 0 "revocation:owner-deactivated-denies" " (reason=user.inactive, userActive=$(json_field "$owner_after" userActive))"
  else
    record 1 "revocation:owner-deactivated-denies" " (decision=$owner_after)"
  fi
  psql_run_sql <<SQL
UPDATE users SET active = TRUE WHERE id = '$REVOKE_USER_ID';
SQL
fi

# --- summary ----------------------------------------------------------------
total=$((pass + fail))
if [ "$fail" -eq 0 ]; then
  printf 'API PROBES: %d/%d PASS\n' "$pass" "$total"
  printf 'REVOCATION: medida en %ss (<%ss exigido)\n' "$rev_seconds" "$REVOCATION_BUDGET_S"
  exit 0
fi
printf 'API PROBES: FAIL (%d/%d, %d failed)\n' "$pass" "$total" "$fail"
printf 'REVOCATION: medida en %ss (<%ss exigido)\n' "$rev_seconds" "$REVOCATION_BUDGET_S"
exit 1
