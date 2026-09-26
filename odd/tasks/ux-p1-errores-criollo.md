# Feature hija: UX-P1 Errores y denegaciones en criollo

**Origen:** `odd/tasks/ux-propuestas.md` P1 + decisiones `odd/tasks/ux-review.md` (59 hallazgos, feedback 7+8 rondas).
**Principios:** cero jerga técnica visible; español neutro; cada fallo dice motivo simple + qué hacer + a quién avisar; detalle técnico solo tras "Copiar detalle".
**Reglas:** sin commits sin orden explícita. Rama feature + commits unidad de trabajo cuando se autorice. Scout propio antes de escribir código.

## Tareas
- [x] P1-0 Mapeo (scout solo lectura): inventario exacto de pantallas con code/reason/traceId/envelope/403/UUID visibles + paneles con EnvelopeFields + flujo sin-sesión con rebote
- [x] P1-1 `denied-notice.tsx` + `session-required-notice.tsx`: denegación cálida y breve con motivo + qué hacer + rol destino + "Copiar detalle" oculto. Verde: page-guard/access 18 pass, tsc limpio. Veredicto verify PASS.
- [x] P1-2 `ui/states.tsx` + `salud/states.tsx` + `salud-errors.ts`: estados genéricos sin jerga, sin inglés snake_case. Verde: web 137 pass, tsc limpio. Verify PASS + fix doble "su rol" verificado (18 pass, tsc limpio).
- [x] P1-3 Paneles salud/obras/tableros: quitar EnvelopeFields visibles, mover a "Copiar detalle". Verde: web 137 pass, tsc limpio. Verify PASS (cero failure.message directo, cero imports EnvelopeFields).
- [x] P1-4 Sin sesión: mensaje único "Entre aquí" → `/login`, sin rebote login↔inicio. Verde: web 137 pass, tsc limpio. Verify PASS (protección intacta, residual con sesión va a P1-5).
- [x] P1-5 Cierre: suites en verde + clics por rol + aceptación (ninguna pantalla muestra UUID/código salvo tras "Copiar detalle"). Verde: web 137 pass, tsc limpio. Verify PASS en 10 archivos + 3 bloques finales; UUIDs de formularios van a P2; smoke navegador pendiente de stack local.

## Fuera
- P2-P7 (otras hijas)
- Cambio de textos de negocio (solo errores/denegaciones)

## Evidencia
- P1-1: commit 4153c1f feat(web) en feat/ux-p1-errores-criollo (3 componentes + doc P1, 148+/42-, page-guard/access 18 pass, tsc limpio, verify PASS)
- P1-2: commits 1e9e326 + 597cef8 (fix doble su rol). P1-3: be6aea2. P1-4: cdaaaaa. P1-5: 539d1ef + 2d87fea + ad8dc99.
- PR #9 abierto de feat/ux-p1-errores-criollo a main (8 commits, 30 archivos, +645/-345). CI: 5 checks SUCCESS, MERGEABLE, pendiente merge con orden explícita.
