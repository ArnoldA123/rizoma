# Feature hija: UX-P3 Portada por rol + tableros visibles

**Origen:** `odd/tasks/ux-propuestas.md` P3 + decisiones `odd/tasks/ux-review.md`.
**Principios:** cada rol entiende su día en 5 segundos; cero infra visible; header con nombre + rol + sede + salir.
**Reglas:** rama feature + commits unidad de trabajo; push + PR + merge autorizados por el usuario (merge solo con CI verde). Scout propio antes de escribir código. Sin commits fuera de la rama.

## Tareas
- [x] P3-0 Mapeo (scout): portada idéntica por rol, 4 cards infra a quitar, tableros tras navHidden, header sin nombre/sede. Decisión: auditor reusa Tablero empresa + movimientos (sin agregado nuevo).
- [x] P3-1a Portada salud (médico, recepción, caja) + shell role-home con datos reales. Verde: web 146, tsc limpio. Verify PASS.
- [x] P3-1b Portada obras + auditor (jefe/capataz/gerente/almacen, obrero con Marcar, auditor con tablero empresa + movimientos). Verde: web 146, tsc limpio. Verify PASS (9 roles delegados; el FAIL inicial fue typo 8 vs 9 en el enunciado).
- [x] P3-2 Quitar tarjetas infra (ApiStatusCard, matrices, Contratos) + badges W* en 12 páginas. Verde: web 146, tsc limpio. Verify PASS (portada siempre RoleHome; /politicas intacta).
- [x] P3-3 Tablero del rol visible (CTA en portadas salud + /obras/tablero en menú; navHidden documentado para segmento dinámico) + header nombre+rol+sede+salir con islas server-side y fallbacks. Verde: web 146, tsc limpio. Verify PASS.
- [x] P3-4 Cierre: suites API 744 + contracts 190 + web 146 en verde; aceptación 5 segundos por rol verificada en estático (título + dato + CTA por rol, cero infra). Verify PASS. Clics de navegador pendientes de stack local. Pulido futuro: "El API respondió…" en empty-states.

## Fuera
- P1-P2 (mergeadas), P4-P7 (otras hijas)
- Lógica de tableros (solo visibilidad y portada)

## Evidencia
- (se registra por tarea: PR de P3 al cierre P3-4)
