# Feature: MVP1 Web — Salud + Obras contra API verificada

**Objetivo:** web Next.js 15 operando en local contra API verificada #33: login Keycloak, fichas 360, agenda, caja/factura, personal/asistencia, equipos/stock/avance/bitácora, CSVs y tableros por rol.
**Problema:** `apps/web` y `packages/contracts` son esqueletos (solo package.json con echo). Backend F0 + API runtime + MVP1 Salud/Obras cerrado en local, sin UI.
**Por qué:** cerrar el flujo registro→consentimiento→cita→atención→cobro→factura y obra→personal→avance con UI usable por rol, sin ampliar alcance a MVP2.
**Predecesor:** Checkpoint Engram #33 (F0 6/6, API runtime 4/4, Salud 5/5 backend, Obras 4/4, 406 unit + 30 E2E obras + 18 E2E salud en verde).
**Mapa API:** explorer `mugcc72t-1-gk3t` 2026-09-25. Base `/v1`, tenant via `Authorization: Bearer` (claim `tenant_id`, fallback `azp`) o `x-tenant-id/x-user-id/x-scopes` en local. Health `GET /health` sin tenant.

## Alcance

Incluye:
- W1 base web real + auth OIDC + contexto tenant + proxy/CORS + contracts mínimos
- W2-W3 Salud web (ficha 360, agenda, episodios, consentimientos, caja/factura, CSV pacientes, tableros recepcion/caja/medico)
- W4-W5 Obras web (ficha obra 360, staff/asistencia, assets/stock/avance/bitácora, CSV workers/assets, tableros site/company)
- W6 cierre (AA flujos críticos, probes web, docs, verificación)

Excluye (MVP2/F2, documentado en gaps):
- Triaje/receta endpoints (tablas en 003 sin controller) — UI muestra estado "no disponible" con placeholder tipificado
- Upload/download archivos con URL firmada (solo `files/paths.ts`) — bitácora fotos y evidencia consentimiento degradan a metadata
- Onboarding HTTP (service puro sin controller) — ruta `/onboarding` degradada hasta exponer API
- Webhooks, API keys públicas, BI completa, builder flujos, WhatsApp/SMS plenos
- Paginación cursor, OpenAPI generado, caché Redis en dashboards (documentado como follow-up)

**Gaps verificados del mapa:**
1. Sin CORS en `main.ts` — web necesita proxy Next o `enableCors`
2. Sin paginación cursor (listas capadas a 200) — UI pagina en cliente
3. Sin triaje/prescripción, sin files, sin onboarding HTTP
4. Dashboards leen primary sin caché, fechas UTC, envelope `{code,message,traceId}`

## Restricciones

- Español neutro en docs, identificadores y código en inglés. Datos sintéticos.
- Sin commits sin orden explícita. Rama feature + commits unidad de trabajo cuando se autorice.
- TDD mode: unknown (sin config explícita en repo). Runner API: `node --test` (ver `apps/api/package.json`). Runner web: por definir (hoy placeholder `echo`). Se resuelve por tarea al delegar.
- Delivery strategy: `ask-on-risk` (default). Forecast >400 líneas autoradas → se aplica estrategia antes del siguiente commit al superar umbral. Presupuesto de entrega lee la rama acumulada, no el heurístico por tarea (~400 líneas/tarea solo planificación).
- Ruta por tarea: delegada (writer trigger multi-file) salvo W1-scout ya hecho y verificaciones 1–3 archivos inline. Ver `Ruta` por tarea.

## Sistema de diseño (aporte usuario 2026-09-25, aplica a W1)

Base neutra 100% sin croma, modo claro/oscuro invertido. Implementar como CSS vars en `apps/web` (Tailwind theme + shadcn tokens):

Claro: `--base-ink:#161615 (texto, CTA primario)` `--base-paper:#FAFAF8 (fondo)` `--base-card:#FFFFFF (tarjetas)` `--base-line:#E9E6DF (hairline)` `--base-muted:#6E6C66 (secundario)` `--base-faint:#F2F0EA (estados)` `--base-hover:#2B2B29 (CTA hover)` `--base-focus:#161615 (foco/links)`. Contraste 17.3:1 AAA.
Oscuro: `--base-ink:#FAF9F5` `--base-paper:#141413` `--base-card:#1B1B1A` `--base-line:#2B2B29` `--base-muted:#A8A6A0` `--base-faint:#222220` `--base-hover:#E3DDCE` `--base-focus:#FAF9F5`.

Pieles: salud y obras derivan de la base neutra solo con acento propio (ej. salud: acento clínico sobrio; obras: acento tierra/seguridad), sin romper la base. Fondo cuadriculado sutil opcional inspirado en captura del usuario (ruta Windows inaccesible desde WSL — si quiere el grid exacto, colocar la imagen en `docs/crm-maleable/_inbox/` y avisar); mientras tanto grid CSS lineal con `base-line` a baja opacidad, desactivable y que no rompa AA. Objetivo: fuera de lo genérico, UX/UI exquisita, AA en flujos críticos.

## Tareas

- [x] W1 Base web + auth + tenant + contracts mínimos — bootstrap Next.js 15 real (App Router + Tailwind + shadcn/ui), login Keycloak OIDC, derivación tenant, guard UI por rol/alcance (espejo `auth/guard.ts`, `auth/policy.ts`), proxy API para CORS, `packages/contracts` con tipos Zod mínimos de Patient/Episode/Appointment/Consent/Invoice/Site/Board. Checks: `npm run build/typecheck/test` web+contracts verde, login cierra sesión, 403 sin fugas muestra `reason+traceId`. Ruta: delegada (multi-file). Evidencia: worker `mugch22h-2-d6cd` ready 2026-09-25 — typecheck contracts 0, build contracts dist OK, typecheck web 0, build web 13 rutas OK, tests web 45/45, contracts 13/13; proxy `/health` 200 live, 403 preservado, dev-fallback bloqueado en prod. Spot check padre: typecheck contracts 0 + tests web 45/45 OK. Assess: `unassessable` (RDD on, outcome unknown) → trátese como high → writer self-verify + verifier independiente en curso. Desvío declarado: `package-lock.json`+`node_modules` por `npm install` (44 paquetes, sin drift API/workers); `apps/web/.env.example` no creado por policy, contrato en `apps/web/README.md`. Gap base heredado: `GET /v1/salud/patients` 500 sin membership (repro con curl directo, fuera de superficies W1) → agendar fix antes de W2 datos reales.
- [x] W2 Salud web: ficha 360 + agenda + episodios + consentimientos — writer `mugdndmg-4-o4yv` ready + spot padre (typecheck web 0, contracts 24/24) + verifier `mugef58y-5-2wwb` ready 2026-09-25 PASS (Idempotency-Key por intent, split canRead/canWrite sin request denegada, optimista con rollback + envelope, un GET episodes por ficha, agenda UTC poll 2 min, navegación patient.read, contratos 24/24; web 45/45). Tier `unassessable`→high, sin review nativa, sin fix batch web. Diferido aceptado: `PATCH patients/:id` no cableado, sin transiciones cita, sin búsqueda, sin archivos. Nota doc: comentario stale en `patient-file.tsx` sobre requests de episodios (código correcto).
- [x] W3 Salud web: caja + CSV + tableros — writer `mugesfa4-8-51l2` ready + spot padre (typecheck web 0, contracts 41/41) + verifier `mugfgci4-9-8ho0` ready 2026-09-25 PASS (serie/doc/IGV/overpay espejados, CSV sha256 replay + descarga por proxy, tableros con poll y caché sin KPIs cruzados, navegación y separación caja/clínica; 45/45 web, 41/41 contracts). Sin fix batch. Limitación honesta: lista de facturas local a sesión (sin endpoint lista en MVP1).
- [x] W4 Obras web: ficha + personal + tableros — writer `mugfk2nu-a-g6bw` ready + spot padre (typecheck web 0, contracts 50/50) + verifier `mugg2tkf-b-skt4` ready 2026-09-25 PASS (two-step con staff como probe incl. gerente/jefe_obra, 11 endpoints con key fresca, tableros 5–15 min con caché por identidad eco, contratos vs CHECKs 005, navegación ordenada; 45/45 web, 50/50 contracts). Notas aceptadas: tablero navHidden por test pinned, tests web nuevos sin cablear, build en W6.
- [x] W5 Obras web: operación + CSV — writer `mugg5h6y-c-ah4j` ready + spot padre (typecheck web 0, contracts 63/63) + verifier `muggu73y-d-wvo7` ready 2026-09-25 PASS (catálogos vs CHECKs 005, importers con hash replay y splits, gate tras two-step key, board pick→panel + refresh tras posted, navegación ordenada; 45/45 web, 63/63 contracts). Notas: ledger local a sesión, un magnético por pantalla, build en W6.
- [x] W6 Cierre MVP1 web — writer `muggxuyb-e-rcfl` ready + spot padre (probes 28/0/1) + verifier `mughraud-f-8kau` ready 2026-09-25 PASS (builds re-corridos: 18 rutas + middleware; test wiring 9/9 + pins por matriz; AA: live-region estable, aria-pressed+group x3, th con scope, contraste ≥4.5; probes estáticas; README completo; regresión 82/82 web, 63/63 contracts, 411/411 API). Decisión producto aceptada: `/obras/tablero` visible a `trabajador` por `site.read` (pineado, reversible en 1 línea).
- [x] W2F Fix API: auditoría de denegación con `org_node_id` nulo sin membership — writer `mugeibo0-6-suhp` ready + spot padre (typecheck API 0) + verifier `mugepter-7-iy8p` ready 2026-09-25 PASS (normalización central + subquery `org_nodes`, 23503 imposible por construcción, fail-closed genuino intacto, RLS/matrix intactos; tests API 411/411). Sin migración (001:97 ya anulable). Placeholders tenant-id restantes neutralizados centralmente; limpieza cosmética opcional.

## Criterios de aceptación

1. Login Keycloak cierra sesión y 403 muestra `reason+traceId` sin fugas.
2. Flujo salud completo visible con auditoría (registro→consentimiento→cita→atención→cobro→factura).
3. Caja web no muestra historia clínica (prueba de denegación UI).
4. Trabajador fuera de obra/baja no marca en UI; jefe solo sus obras.
5. Consumo descuenta stock en `posted` visible en ficha.
6. CSVs operativos con errores descargables; tableros por rol con poll y caché cliente.
7. AA verificada en flujos críticos; build+tests verdes.

## Progreso

- 2026-09-25: feature creada desde selección Web MVP1 + mapa `mugcc72t-1-gk3t`. 6 tareas W1-W6 pendientes. Sin writes aún.
- 2026-09-25: W6 cerrada + FEATURE CERRADA (7/7 con W2F). Criterios 1-7 verificados salvo flujo atención (sin transiciones cita en MVP1, documentado) y probes vivas (requieren stack, manuales en probe). Delivery: sin commits (git no inicializado en proyecto + sin orden explícita); chain strategy pendiente al autorizar commits.

## Evidencia de verificación

- Mapa: explorer `mugcc72t-1-gk3t` (controladores, auth, dashboards, CSV, billing, gaps, IA mínima).
- W1: writer `mugch22h-2-d6cd` ready + spot check padre (typecheck contracts 0, tests web 45/45) + verifier `mugdk2iz-3-tjj0` ready 2026-09-25 (paridad access 14 roles x 12 acciones y 9 reasons, proxy fail-closed, PKCE/state/HttpOnly, gate prod, tema exacto, contratos caja/médico separados; typecheck/build/tests 0 + 45/45 + 13/13). Tier: `unassessable`→high (RDD on, outcome unknown); outcome: verifier independiente ready, sin review nativa iniciada. Sin fix batch.
- W2F: writer `mugeibo0-6-suhp` + spot padre + verifier `mugepter-7-iy8p` ready (411/411 API).
- W3: writer `mugesfa4-8-51l2` + spot padre + verifier `mugfgci4-9-8ho0` ready (45/45 web, 41/41 contracts).
- W5: writer `mugg5h6y-c-ah4j` + spot padre + verifier `muggu73y-d-wvo7` ready (45/45 web, 63/63 contracts).
- W6: writer `muggxuyb-e-rcfl` + spot padre + verifier `mughraud-f-8kau` ready (builds 18 rutas, 82/82 web, 63/63 contracts, 411/411 API, probes 28/0/1).

## Cierre

Feature MVP1 Web 7/7 cerrada 2026-09-25. Deuda honesta: transiciones de cita, búsquedas, archivos firmados, onboarding HTTP, listas GET (facturas/equipos/stock) → ledgers locales, fotos como metadata. Siguiente propuesta: MVP2 (API pública + webhooks + billing por uso) o endurecer despliegue local (compose up + Keycloak realm + seeds + probes vivas).

## Entrega (repo privado ArnoldA123/rizoma, rama main)

- `df14e9b` chore base backend (93 archivos) en `main`
- `58a203e` feat web W1-W6+W2F (137 archivos) vía PR #1 `feature/mvp1-web` → `main`, merge `ac6c01f` (rama eliminada)
- 2 commits honestos en vez de 7 retroactivos (archivos solapados entre tareas; evidencia por tarea en este doc + Engram #33/#34/#40)
- Árbol limpio post-merge; `.gitignore` ampliado (`.next/`, `*.tsbuildinfo`) antes del commit 1

## Siguiente paso

- Cerrado. Proponer siguiente feature (MVP2 o despliegue) solo con autorización; sin writes hasta entonces.
