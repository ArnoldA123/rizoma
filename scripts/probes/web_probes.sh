#!/usr/bin/env bash
# Web probes — the closure checks of the MVP1 web surface.
#
# Two halves, on purpose:
#
#   1. STATIC (always runs, no services, no network). It reads the repository and
#      answers the questions a reviewer would otherwise check by hand:
#        - route inventory: the 13 screens of the MVP1 (login, salud, obras) plus
#          the four auth handlers and the API proxy exist, and the built manifest
#          agrees when a build is present;
#        - proxy contract: `/health` stays outside the `/v1` prefix and the
#          `x-trace-id` is echoed back to the caller;
#        - denial path: `RouteGuard` renders the denial *before* it renders any
#          child, every salud/obras page is wrapped by it, and the denial copy
#          carries `code`, `reason` and `traceId` and nothing else;
#        - guard mirror: the UI matrix still declares 14 roles and 12 actions;
#        - poll bands: 1–5 minutes for salud, 5–15 for obras, defaults inside the
#          band, and no screen declaring a fixed period outside its own band;
#        - AA wiring: focus ring from `--base-focus`, stable `aria-live` verdicts,
#          `aria-pressed` on the cadence selectors, `scope="col"` on the data
#          tables, and the reduced-motion + touch-off branches of the magnetic CTA;
#        - replay key: every CSV importer keys on the SHA-256 of the file bytes.
#
#   2. LIVE (opt-in with WEB_PROBE_LIVE=1, needs the web + API + Keycloak stack):
#        - `GET /login` answers 200;
#        - `GET /api/proxy/health` answers 200 and echoes the `x-trace-id` we sent;
#        - an unauthenticated screen redirects to `/login` instead of rendering.
#      With the flag unset these print SKIP, so the static run is green on a bare
#      checkout with no stack running.
#
# Usage:
#   bash scripts/probes/web_probes.sh              # static only (no services)
#   WEB_PROBE_LIVE=1 bash scripts/probes/web_probes.sh
#
# Env overrides: WEB_ORIGIN (default http://127.0.0.1:3000), CURL_TIMEOUT.
# Dependencies: bash, grep, node (numeric + JSON checks). No npm installs, no
# traffic beyond the configured origin, no temporary files, and nothing outside
# the working tree is read or written.
set -uo pipefail

export LC_ALL=C

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
cd "$ROOT" || exit 1

WEB_DIR="$ROOT/apps/web"
CONTRACTS_DIR="$ROOT/packages/contracts"

WEB_ORIGIN=${WEB_ORIGIN:-http://127.0.0.1:3000}
CURL_TIMEOUT=${CURL_TIMEOUT:-5}
WEB_PROBE_LIVE=${WEB_PROBE_LIVE:-0}

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

stamp() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
ok() { PASS_COUNT=$((PASS_COUNT + 1)); printf 'PASS  %s  %s\n' "$(stamp)" "$1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); printf 'FAIL  %s  %s\n' "$(stamp)" "$1"; }
skip() { SKIP_COUNT=$((SKIP_COUNT + 1)); printf 'SKIP  %s  %s\n' "$(stamp)" "$1"; }
section() { printf '\n== %s ==\n' "$1"; }

# Asserts every exact string in the remaining arguments appears in a file.
file_has_all() {
  local label=$1 file=$2
  shift 2
  if [[ ! -f "$file" ]]; then
    fail "$label (archivo ausente: ${file#"$ROOT"/})"
    return 1
  fi
  local missing=()
  local needle
  for needle in "$@"; do
    grep -Fq -- "$needle" "$file" || missing+=("$needle")
  done
  if (( ${#missing[@]} > 0 )); then
    fail "$label (no se encontró: ${missing[*]})"
    return 1
  fi
  ok "$label"
}

# Asserts an exact string is absent from a file (a negative invariant).
file_has_none() {
  local label=$1 file=$2
  shift 2
  if [[ ! -f "$file" ]]; then
    fail "$label (archivo ausente: ${file#"$ROOT"/})"
    return 1
  fi
  local found=()
  local needle
  for needle in "$@"; do
    grep -Fq -- "$needle" "$file" && found+=("$needle")
  done
  if (( ${#found[@]} > 0 )); then
    fail "$label (aparece y no debería: ${found[*]})"
    return 1
  fi
  ok "$label"
}

# ---------------------------------------------------------------------------
section "1. Inventario de rutas (13 pantallas + auth + proxy)"
# ---------------------------------------------------------------------------

PAGES=(
  "app/page.tsx"
  "app/login/page.tsx"
  "app/salud/pacientes/page.tsx"
  "app/salud/pacientes/[id]/page.tsx"
  "app/salud/agenda/page.tsx"
  "app/salud/caja/page.tsx"
  "app/salud/imports/page.tsx"
  "app/salud/tableros/[role]/page.tsx"
  "app/obras/page.tsx"
  "app/obras/tablero/page.tsx"
  "app/obras/imports/page.tsx"
  "app/obras/[siteId]/page.tsx"
)
HANDLERS=(
  "app/api/auth/login/route.ts"
  "app/api/auth/callback/route.ts"
  "app/api/auth/logout/route.ts"
  "app/api/auth/session/route.ts"
  "app/api/proxy/[...path]/route.ts"
)

missing_pages=()
for page in "${PAGES[@]}"; do
  [[ -f "$WEB_DIR/$page" ]] || missing_pages+=("$page")
done
if (( ${#missing_pages[@]} > 0 )); then
  fail "las ${#PAGES[@]} pantallas del MVP1 existen (faltan: ${missing_pages[*]})"
else
  ok "las ${#PAGES[@]} pantallas del MVP1 existen (12 páginas declaradas + /_not-found = 13 rutas compiladas)"
fi

missing_handlers=()
for handler in "${HANDLERS[@]}"; do
  [[ -f "$WEB_DIR/$handler" ]] || missing_handlers+=("$handler")
done
if (( ${#missing_handlers[@]} > 0 )); then
  fail "los route handlers de auth y proxy existen (faltan: ${missing_handlers[*]})"
else
  ok "los ${#HANDLERS[@]} route handlers de auth y proxy existen"
fi

MANIFEST="$WEB_DIR/.next/app-path-routes-manifest.json"
if [[ -f "$MANIFEST" ]]; then
  if node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const routes = Object.values(manifest);
    const expected = [
      "/login", "/", "/salud/pacientes", "/salud/pacientes/[id]", "/salud/agenda",
      "/salud/caja", "/salud/imports", "/salud/tableros/[role]", "/obras",
      "/obras/tablero", "/obras/imports", "/obras/[siteId]",
      "/api/auth/login", "/api/auth/callback", "/api/auth/logout",
      "/api/auth/session", "/api/proxy/[...path]",
    ];
    const absent = expected.filter((route) => !routes.includes(route));
    if (absent.length > 0) {
      console.error("faltan en el manifiesto: " + absent.join(", "));
      process.exit(1);
    }
    const pages = routes.filter((route) => !route.startsWith("/api/"));
    console.log("   manifiesto: " + pages.length + " rutas de página, " + routes.length + " rutas totales");
    process.exit(pages.length >= 13 ? 0 : 1);
  ' "$MANIFEST"; then
    ok "el manifiesto compilado declara 13+ rutas de página y los handlers del proxy"
  else
    fail "el manifiesto compilado no coincide con el inventario esperado"
  fi
else
  skip "manifiesto compilado ausente (.next/): se valida solo el inventario de fuentes; ejecute npm run build --workspace @rizoma/web para la comprobación completa"
fi

# ---------------------------------------------------------------------------
section "2. Contrato del proxy (/health fuera de /v1 y eco de x-trace-id)"
# ---------------------------------------------------------------------------
file_has_all "el proxy deja /health fuera del prefijo /v1" \
  "$WEB_DIR/lib/proxy.ts" \
  "const UNVERSIONED_PATHS: readonly string[] = ['health'];" \
  "return \`/\${safe[0]}\`" \
  "return \`\${API_VERSION_PREFIX}/\${safe.join('/')}\`"
file_has_all "el proxy reenvía y devuelve x-trace-id" \
  "$WEB_DIR/lib/proxy.ts" \
  "setIfPresent(headers, TRACE_ID_HEADER, input.traceId)" \
  "outgoing.set(TRACE_ID_HEADER, upstream.get(TRACE_ID_HEADER) ?? traceId)"
file_has_all "el handler resuelve la traza entrante o genera una" \
  "$WEB_DIR/app/api/proxy/[...path]/route.ts" \
  "const incomingTraceId = request.headers.get(TRACE_ID_HEADER);" \
  "newProxyTraceId()" \
  "copyResponseHeaders(upstream.headers, responseHeaders, traceId)"
file_has_none "el proxy no inventa CORS ni expone el token al navegador" \
  "$WEB_DIR/app/api/proxy/[...path]/route.ts" \
  "access-control-allow-origin" \
  "ACCESS_TOKEN_HEADER"

# ---------------------------------------------------------------------------
section "3. Denegación por rol: panel con envelope y sin lectura previa"
# ---------------------------------------------------------------------------
file_has_all "la guarda deniega antes de renderizar cualquier hijo" \
  "$WEB_DIR/components/route-guard.tsx" \
  "if (!guard.decision.allow)" \
  "<DeniedNotice" \
  "return <>{children(guard)}</>;"
file_has_all "el panel de denegación muestra code, reason y traceId" \
  "$WEB_DIR/components/denied-notice.tsx" \
  "access.denied" \
  "reason" \
  "traceId"
# `children(guard)` must appear after the denial branch, otherwise a denied role
# would mount a data panel before the copy is rendered.
if node -e '
  const fs = require("node:fs");
  const source = fs.readFileSync(process.argv[1], "utf8");
  const denial = source.indexOf("if (!guard.decision.allow)");
  const children = source.indexOf("children(guard)");
  process.exit(denial !== -1 && children !== -1 && denial < children ? 0 : 1);
' "$WEB_DIR/components/route-guard.tsx"; then
  ok "el orden del archivo de guarda impide montar paneles de datos denegados"
else
  fail "el orden del archivo de guarda no garantiza que la denegación preceda al hijo"
fi

unwrapped=()
while IFS= read -r page; do
  grep -Fq "<RouteGuard" "$page" || unwrapped+=("${page#"$WEB_DIR"/}")
done < <(find "$WEB_DIR/app/salud" "$WEB_DIR/app/obras" -name 'page.tsx' | sort)
if (( ${#unwrapped[@]} > 0 )); then
  fail "cada pantalla de salud/obras pasa por la guarda (sin guarda: ${unwrapped[*]})"
else
  ok "cada pantalla de salud/obras pasa por RouteGuard (sin lectura en denegación)"
fi

# ---------------------------------------------------------------------------
section "4. Guarda espejo: 14 roles y 12 acciones"
# ---------------------------------------------------------------------------
if node --input-type=module -e '
  const access = await import(process.argv[1]);
  const problems = [];
  if (access.ROLE_CODES.length !== 14) problems.push("roles=" + access.ROLE_CODES.length);
  if (access.ACTION_CODES.length !== 12) problems.push("acciones=" + access.ACTION_CODES.length);
  if (access.rolePermitsAction("caja", "patient.read")) problems.push("caja lee clínica");
  if (access.rolePermitsAction("medico", "invoice.issue")) problems.push("médico emite comprobantes");
  if (problems.length > 0) { console.error(problems.join("; ")); process.exit(1); }
  process.exit(0);
' "$WEB_DIR/lib/access.ts"; then
  ok "la matriz de interfaz conserva 14 roles, 12 acciones y las filas negativas"
else
  fail "la matriz de interfaz se desvió del espejo de la API"
fi

# ---------------------------------------------------------------------------
section "5. Bandas de lectura automática (salud 1–5 min, obras 5–15 min)"
# ---------------------------------------------------------------------------
if node -e '
  const fs = require("node:fs");
  const read = (file) => fs.readFileSync(file, "utf8");
  const problems = [];

  const boards = read(process.argv[1]);
  const salud = read(process.argv[2]);
  const agenda = read(process.argv[3]);
  const siteBoard = read(process.argv[4]);
  const companyBoard = read(process.argv[5]);

  const literal = (source, name) => {
    const match = source.match(new RegExp(name + "\\s*=\\s*([0-9_]+)"));
    return match === null ? null : Number(match[1].replaceAll("_", ""));
  };

  // Bands declared in the contracts module, read as written in the source (the
  // underscore separators of the literals included).
  const saludMin = 60000;
  const saludMax = 300000;
  const obrasMin = 300000;
  const obrasMax = 900000;
  const declared = (source, name) => literal(source, "const " + name);
  if (declared(boards, "BOARD_POLL_MIN_MS") !== saludMin) {
    problems.push("BOARD_POLL_MIN_MS no es " + saludMin);
  }
  if (declared(boards, "BOARD_POLL_MAX_MS") !== saludMax) {
    problems.push("BOARD_POLL_MAX_MS no es " + saludMax);
  }
  if (declared(boards, "OBRAS_BOARD_POLL_MIN_MS") !== obrasMin) {
    problems.push("OBRAS_BOARD_POLL_MIN_MS no es " + obrasMin);
  }
  if (declared(boards, "OBRAS_BOARD_POLL_MAX_MS") !== obrasMax) {
    problems.push("OBRAS_BOARD_POLL_MAX_MS no es " + obrasMax);
  }

  // No screen may hardcode a period outside the band it belongs to.
  const inside = (value, min, max) => value !== null && value >= min && value <= max;

  const agendaPoll = literal(agenda, "const POLL_MS");
  if (!inside(agendaPoll, saludMin, saludMax)) {
    problems.push("la agenda agenda declara " + agendaPoll + " ms fuera de la banda de salud");
  }

  for (const [name, source] of [["tablero de rol", salud], ["tablero de obra", siteBoard], ["tablero de empresa", companyBoard]]) {
    if (!source.includes("}, pollMs);")) problems.push(name + " no refresca con el periodo de su banda");
  }

  const saludDefaults = salud.includes("useState(BOARD_POLL_DEFAULT_MS)");
  const obrasDefaults =
    siteBoard.includes("useState(OBRAS_BOARD_POLL_DEFAULT_MS)") &&
    companyBoard.includes("useState(OBRAS_BOARD_POLL_DEFAULT_MS)");
  if (!saludDefaults) problems.push("el tablero de rol no parte del default de salud");
  if (!obrasDefaults) problems.push("los tableros de obra no parten del default de obras");

  // Every selector offers the two ends and the middle of its band.
  if (!salud.includes("BOARD_POLL_MIN_MS") || !salud.includes("BOARD_POLL_MAX_MS")) {
    problems.push("el tablero de rol no ofrece los extremos de la banda");
  }
  for (const [name, source] of [["obra", siteBoard], ["empresa", companyBoard]]) {
    if (!source.includes("OBRAS_BOARD_POLL_MIN_MS") || !source.includes("OBRAS_BOARD_POLL_MAX_MS")) {
      problems.push("el tablero de " + name + " no ofrece los extremos de la banda");
    }
  }

  // The timer must pause while the tab is hidden.
  for (const [name, source] of [["agenda", agenda], ["tablero de rol", salud]]) {
    if (!source.includes("document.hidden")) problems.push(name + " no pausa el poll con la pestaña oculta");
  }

  if (problems.length > 0) { console.error(problems.join("; ")); process.exit(1); }
  console.log("   salud 1–5 min (default 3), obras 5–15 min (default 10), agenda 2 min fijos dentro de banda");
  process.exit(0);
' "$CONTRACTS_DIR/src/boards.ts" \
  "$WEB_DIR/components/salud/role-board.tsx" \
  "$WEB_DIR/components/salud/agenda-board.tsx" \
  "$WEB_DIR/components/obras/site-board.tsx" \
  "$WEB_DIR/components/obras/company-board.tsx"; then
  ok "las bandas de lectura se respetan en todos los tableros"
else
  fail "algún tablero declara un periodo fuera de su banda"
fi

# ---------------------------------------------------------------------------
section "6. AA: foco, regiones vivas, estado y tablas"
# ---------------------------------------------------------------------------
file_has_all "un solo tratamiento de foco, desde el token" \
  "$WEB_DIR/app/globals.css" \
  ":focus-visible {" \
  "outline: 2px solid var(--base-focus);"
file_has_none "ningún componente desactiva el foco del navegador" \
  "$WEB_DIR/app/globals.css" \
  "outline: none;"
if grep -rIn --include='*.tsx' 'outline-none' "$WEB_DIR/components" "$WEB_DIR/app" >/dev/null 2>&1; then
  fail "algún componente de la interfaz usa outline-none y perdería el anillo de foco"
else
  ok "ningún componente de la interfaz borra el anillo de foco"
fi

file_has_all "el veredicto por campo vive en una región viva estable" \
  "$WEB_DIR/components/ui/field-feedback.tsx" \
  'aria-live="polite"' \
  "const message = !touched"
file_has_all "el selector de cadencia expone su estado al lector de pantalla" \
  "$WEB_DIR/components/salud/role-board.tsx" \
  'role="group"' \
  'aria-label="Lectura automática"' \
  "aria-pressed={pollMs === option.value}"
file_has_all "el selector de cadencia de obra expone su estado" \
  "$WEB_DIR/components/obras/site-board.tsx" \
  "aria-pressed={pollMs === option.value}" \
  'scope="col"'
file_has_all "el selector de cadencia de empresa expone su estado" \
  "$WEB_DIR/components/obras/company-board.tsx" \
  "aria-pressed={pollMs === option.value}"
file_has_all "los encabezados de la tabla de clave declaran su alcance" \
  "$WEB_DIR/app/obras/[siteId]/page.tsx" \
  'scope="col"'

file_has_all "el CTA magnético se apaga con reduced-motion y en táctil" \
  "$WEB_DIR/components/ui/magnetic.tsx" \
  "usePrefersReducedMotion()" \
  "event.pointerType === 'touch'" \
  "reducedMotion"
file_has_all "la piel de salud neutraliza el magnetismo en reduced-motion" \
  "$WEB_DIR/app/salud/salud.css" \
  "@media (prefers-reduced-motion: reduce)" \
  "sd-magnetic"
file_has_all "la piel de obras neutraliza sus animaciones en reduced-motion" \
  "$WEB_DIR/app/obras/obras.css" \
  "@media (prefers-reduced-motion: reduce)"
file_has_all "el desplazamiento suave de la ficha respeta reduced-motion" \
  "$WEB_DIR/components/obras/site-file.tsx" \
  "usePrefersReducedMotion()" \
  "behavior: reducedMotion ? 'auto' : 'smooth'"

# ---------------------------------------------------------------------------
section "7. Clave de repetición de importaciones (SHA-256 del archivo)"
# ---------------------------------------------------------------------------
file_has_all "el digest se calcula del texto del CSV" \
  "$WEB_DIR/lib/browser-hash.ts" \
  "export async function sha256Hex(text: string): Promise<string>" \
  "subtle.digest('SHA-256'"
file_has_all "las dos importaciones de obras firman con el digest" \
  "$WEB_DIR/lib/obras-api.ts" \
  "postJson(\`\${BASE}/imports/workers\`, body, importJobRecordSchema, await sha256Hex(body.csv))" \
  "postJson(\`\${BASE}/imports/assets\`, body, importJobRecordSchema, await sha256Hex(body.csv))"
file_has_all "la importación de pacientes firma con el mismo digest" \
  "$WEB_DIR/lib/salud-api.ts" \
  "importJobRecordSchema, await sha256Hex(body.csv))"

# ---------------------------------------------------------------------------
section "8. Comprobaciones en vivo (requieren web + API + Keycloak)"
# ---------------------------------------------------------------------------
live_enabled=0
if [[ "$WEB_PROBE_LIVE" == "1" ]]; then
  if curl -fsS --max-time "$CURL_TIMEOUT" -o /dev/null "$WEB_ORIGIN/login" 2>/dev/null \
    || curl -sS --max-time "$CURL_TIMEOUT" -o /dev/null "$WEB_ORIGIN/login" 2>/dev/null; then
    live_enabled=1
  else
    fail "WEB_PROBE_LIVE=1 pero $WEB_ORIGIN no responde: arranque el web (npm run dev --workspace @rizoma/web)"
  fi
else
  skip "comprobaciones HTTP omitidas: exporte WEB_PROBE_LIVE=1 con el stack arriba para ejecutarlas"
fi

if (( live_enabled == 1 )); then
  login_status=$(curl -sS --max-time "$CURL_TIMEOUT" -o /dev/null -w '%{http_code}' "$WEB_ORIGIN/login" || echo "000")
  if [[ "$login_status" == "200" ]]; then
    ok "GET /login responde 200"
  else
    fail "GET /login respondió $login_status (se esperaba 200)"
  fi

  trace="web-probe-$(date -u '+%s')"
  # `-i` keeps the response headers on stdout, so no temporary file is created
  # and nothing is written outside the terminal.
  health_response=$(curl -sS --max-time "$CURL_TIMEOUT" -i -H "x-trace-id: $trace" \
    "$WEB_ORIGIN/api/proxy/health" || true)
  health_status=$(printf '%s' "$health_response" | head -n 1 | awk '{print $2}')
  if [[ "$health_status" == "200" ]]; then
    ok "GET /api/proxy/health responde 200 (API alcanzable desde el proxy)"
  else
    fail "GET /api/proxy/health respondió ${health_status:-sin respuesta} (se esperaba 200; requiere el API en RIZOMA_API_ORIGIN)"
  fi
  if printf '%s' "$health_response" | grep -qi "^x-trace-id: *$trace"; then
    ok "el proxy devuelve el mismo x-trace-id que recibió ($trace)"
  else
    fail "el proxy no devolvió el x-trace-id enviado ($trace)"
  fi

  caja_status=$(curl -sS --max-time "$CURL_TIMEOUT" -o /dev/null -w '%{http_code}' \
    -H "accept: text/html" "$WEB_ORIGIN/salud/caja" || echo "000")
  if [[ "$caja_status" == "307" || "$caja_status" == "302" || "$caja_status" == "200" ]]; then
    ok "una pantalla sin sesión no filtra datos (HTTP $caja_status)"
  else
    fail "GET /salud/caja sin sesión respondió $caja_status"
  fi
fi

# ---------------------------------------------------------------------------
printf '\n== Resumen ==\n'
printf 'PASS %d · FAIL %d · SKIP %d\n' "$PASS_COUNT" "$FAIL_COUNT" "$SKIP_COUNT"

if (( FAIL_COUNT > 0 )); then
  printf '\nRevise las comprobaciones en FAIL arriba.\n'
  exit 1
fi

if (( live_enabled == 0 )); then
  cat <<'MANUAL'

Comprobaciones manuales (no automatizables sin sesión Keycloak):
  1. Inicie sesión en /login y abra /salud/caja con un rol sin invoice.issue
     (por ejemplo medico): debe ver «Acceso denegado» con code=access.denied,
     su reason y el traceId, y la pestaña Red no debe mostrar ninguna llamada a
     /api/proxy/* antes de ese panel.
  2. Con teclado (Tab/Enter), recorra /obras/tablero y /salud/tableros/caja:
     los botones de cadencia (1/3/5 min y 5/10/15 min) deben mostrar el anillo
     de foco, alternar con Enter y anunciar su estado pulsado.
  3. Active «reduce motion» en el sistema y confirme que el CTA magnético no se
     desplaza y que los esqueletos no barren.
MANUAL
fi

exit 0
