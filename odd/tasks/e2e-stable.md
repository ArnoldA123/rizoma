# Fix: estabilizar E2E (flakes 404 tras crear)

**Origen:** PR #10 (1 flake: PATCH close → 404 tras POST 201) y PR #12
(4 flakes 404 + tormenta de cancelaciones por rerun manual). Familia
finish-commit race (ver c885909 que hizo poll de patient tras crear).
**Reglas:** rama fix + commits unidad de trabajo; push + PR + merge con CI
verde (main protegida). Sin cambios de negocio, solo harness/tests.

## Tareas
- [ ] E0 Mapeo (scout solo lectura): secuencias crear→usar sin poll en salud.e2e/obras.e2e, helpers existentes (auditByTraceEventually, call), mecanismo finish-commit, job CI e2e
- [x] E1 Poll-until-visible en las secuencias frágiles (mismo patrón c885909). Verde: salud 18/18 + obras 30/30 en 2 DBs frescas. Verify PASS (retry solo 404 transitorio, denegaciones directas).
- [x] E2 Cierre: e2e verde estable (repetidas locales o re-corridas CI) + PR + merge. PR #13 mergeado (13f3e80) con CI 5/5 a la primera.

## Fuera
- Cambios de negocio o migraciones
- P4-P7

## Evidencia
- (se registra por tarea)
