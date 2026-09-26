# Feature hija: UX-P1 Errores y denegaciones en criollo

**Origen:** `odd/tasks/ux-propuestas.md` P1 + decisiones `odd/tasks/ux-review.md` (59 hallazgos, feedback 7+8 rondas).
**Principios:** cero jerga técnica visible; español neutro; cada fallo dice motivo simple + qué hacer + a quién avisar; detalle técnico solo tras "Copiar detalle".
**Reglas:** sin commits sin orden explícita. Rama feature + commits unidad de trabajo cuando se autorice. Scout propio antes de escribir código.

## Tareas
- [x] P1-0 Mapeo (scout solo lectura): inventario exacto de pantallas con code/reason/traceId/envelope/403/UUID visibles + paneles con EnvelopeFields + flujo sin-sesión con rebote
- [x] P1-1 `denied-notice.tsx` + `session-required-notice.tsx`: denegación cálida y breve con motivo + qué hacer + rol destino + "Copiar detalle" oculto. Verde: page-guard/access 18 pass, tsc limpio. Veredicto verify PASS.
- [x] P1-2 `ui/states.tsx` + `salud/states.tsx` + `salud-errors.ts`: estados genéricos sin jerga, sin inglés snake_case. Verde: web 137 pass, tsc limpio. Verify PASS + fix doble "su rol" verificado (18 pass, tsc limpio).
- [ ] P1-3 Paneles salud/obras/tableros: quitar EnvelopeFields visibles, mover a "Copiar detalle"
- [ ] P1-4 Sin sesión: mensaje único "Entre aquí" → `/login`, sin rebote login↔inicio
- [ ] P1-5 Cierre: suites en verde + clics por rol + aceptación (ninguna pantalla muestra UUID/código salvo tras "Copiar detalle")

## Fuera
- P2-P7 (otras hijas)
- Cambio de textos de negocio (solo errores/denegaciones)

## Evidencia
- P1-1: commit 4153c1f feat(web) en feat/ux-p1-errores-criollo (3 componentes + doc P1, 148+/42-, page-guard/access 18 pass, tsc limpio, verify PASS)
- (se registra por tarea: PR de P1 al cierre P1-5)
