# Feature hija: UX-P4 Hora de la sede + agenda legible

**Origen:** `odd/tasks/ux-propuestas.md` P4 + decisiones `odd/tasks/ux-review.md`.
**Principios:** la hora es de la sede (nunca UTC visible); "hoy" es el día de
la sede; citar sin miedo; reprogramar/anular en dos clics.
**Reglas:** rama feature + commits unidad de trabajo; push + PR + merge con
CI verde (main protegida). Scout propio antes de escribir código.

**Decisiones (usuario + criterio ingeniería):** timezone IANA por sede; derivación como estado `derived` (audit_log ya traza quién/cuándo, tabla nueva = sobrediseño); aviso BullMQ diferido por cita; aviso 24h solo a `confirmed`, `scheduled` sin confirmar se libera.

## Tareas
- [x] P4-0 Mapeo (scout): sin timezone en 001, todo UTC, 7 estados DB vs 5 contratos, sin PATCH citas ni Emitir, sin scheduler.
- [x] P4-1a Backend: 010 timezone IANA + día por sede en tableros + zona en org. Verde: API 754, contracts 190. Verify PASS.
- [x] P4-1b Web: día de la sede en agenda/asistencia/portadas (cero UTC visible). Verde: web 148, tsc limpio. Verify PASS.
- [x] P4-1c Hora sede en 5 paneles salud + hook useSedeTimezone. Verde: web 153. Verify PASS.
- [x] P4-1d Hora sede en 7 restantes (obras + caja + imports). Cero formatUtcStamp visibles (solo definición legacy). Verde: web 153.
- [x] P4-2a Backend: 011 transiciones cita + PATCH status/reschedule + derived + Emitir receta + policy appointment.attend + contratos. Verde: API 791, contracts 190, web 148. Verify PASS.
- [x] P4-2b Web: botones Confirmar→Atender/No-show/Reprogramar/Anular (dos clics) + Emitir + Derivar + tests. Verde: web 151, tsc limpio. Verify PASS.
- [x] P4-3 Aviso 24h diferido BullMQ + worker vivo + sweep liberación cada 15 min + compose. Verde: API 802, workers 88, contracts 190. Verify PASS (drenaje real probado en boot).
- [x] P4-4 Cierre: suites API 802 + workers 88 + contracts 190 + web 153 en verde (1233 total); aceptación P4 (cero UTC visible, máquina de citas, reminder + liberación con worker vivo). Verify PASS. Clics de navegador pendientes de stack app.

## Fuera
- P1-P3 (mergeadas), P5-P7 (otras hijas)
- Proveedor real de pago (ya fuera desde notify)

## Evidencia
- (se registra por tarea)
