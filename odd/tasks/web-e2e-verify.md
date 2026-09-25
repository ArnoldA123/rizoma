# Feature: Verificación E2E web como usuario (Playwright)

**Objetivo:** recorrer todas las interfaces como usuario real con `playwright-cli`: tour médico (salud) y gerente (obras), más flujo login Keycloak hasta TOTP, con screenshots y reporte. El humano mira en paralelo en su navegador.
**Por qué:** el usuario quiere ver y probar antes de dar visto bueno; ayer el login pedía 2FA (correcto) y quiere link + credenciales para mirar a la vez.
**Predecesor:** MVP1 Web 7/7 entregada (Engram #40, repo ArnoldA123/rizoma main).
** Herramienta:** `playwright-cli` global 0.1.21 + Playwright 1.63 + chromium. Skill: `/home/chomb/.pi/agent/skills/playwright-cli/SKILL.md`.

## Alcance

Incluye:
- E1 Stack arriba (infra ya healthy, migrate, API :3001, web médico :3000 + gerente :3002 con identidad local dev)
- E2 Tour médico: `/`, `/salud/pacientes`, `/salud/pacientes/[id]`, `/salud/agenda`, `/salud/caja`, `/salud/imports`, `/salud/tableros/*`
- E3 Tour gerente: `/obras`, `/obras/[siteId]`, `/obras/tablero`, `/obras/imports`
- E4 Login Keycloak (`/login` → realm) hasta página TOTP con `medico.demo` (2FA la completa el humano; probar que el flujo llega)
- E5 Reporte + fixes menores si salen (nuevo hallazgo = nueva tarea, no scope silencioso)

Excluye: completar TOTP por el worker (lo hace el humano), E2E automatizados persistentes (propuesta aparte), datos reales no sintéticos.

## Accesos para el humano (paralelo)

- Salud (médico, sin login): http://localhost:3000
- Obras (gerente, sin login): http://localhost:3002
- Login Keycloak: `medico.demo` / `rizoma_demo_password` (pide TOTP: escanear QR con app y confirmar; `admin.demo` igual para ti_admin)
- Consola Keycloak: http://localhost:8080 (`admin` / `rizoma_demo_password`)
- API health: http://127.0.0.1:3001/health

## Restricciones

- Datos sintéticos e2e. Sin commits sin orden. Un writer a la vez.
- TDD n/a (verificación). Runner: comandos exactos del worker + `bash scripts/probes/web_probes.sh`.

## Tareas

- [x] E1 Stack arriba + health verde (infra, migrate, API, web x2) — 2026-09-26: infra healthy, migrate OK, API :3001 health ok (pg+redis), web :3000 médico 200 + :3002 gerente 200. PIDs: API 5949, MED 6171, GER 6173.
- [x] E2 Tour médico con screenshots — worker `muh15qyz-1-34fz` 2026-09-26: 8 pantallas 200 OK (home, pacientes 68 filas + validación viva, ficha 360, agenda, caja denegada con 0 proxy calls, imports, tablero + dark/grid toggles). Screenshots en /tmp/rizoma-e2e/medico-*.png.
- [x] E3 Tour gerente con screenshots — halló F1 (500s) y quedó verificado tras el fix (200s en /obras, /tablero, /imports). Denegación médico→obras OK. Screenshots obras-*.png.
- [x] E4 Login Keycloak hasta TOTP — llega a página "One-time code" (medico.demo YA tiene TOTP enrolado, no QR de setup). Sin completar 2FA. Screenshot login-totp.png.
- [x] E5 Reporte + fixes menores — F1 CERRADA (writer + spot 82/82 + live 200s x3 + verifier `muh1iioi-3-yn7x` ready). Cosméticos pendientes: favicon 404.

## Cierre

Feature web-e2e-verify 5/5 cerrada 2026-09-26. E2 ✅ E3 ✅(tras F1) E4 ✅(OTP, TOTP enrolado). Screenshots en /tmp/rizoma-e2e/. Fix F1 SIN COMMITEAR (navigation.ts + access.test.ts) — commit solo con orden explícita. Stack arriba para el humano (:3000/:3002/:3001/:8080). Espejo Engram pendiente (mem_save falla; fuente de verdad: este archivo).

## Criterios de aceptación

1. Todas las rutas listadas cargan 200 sin error wall en ambos roles.
2. Negaciones esperadas (caja↔clínica, trabajador) muestran `access.denied` + traceId.
3. Login Keycloak llega a TOTP con credenciales demo.
4. Screenshots por pantalla en reporte.

## Progreso

- 2026-09-26: feature creada. Sin writes aún.

## Evidencia de verificación

- Pendiente: snapshot/findings del worker + screenshots.

## Siguiente paso

- E1: levantar servicios (padre, inline).
