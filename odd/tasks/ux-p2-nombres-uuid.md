# Feature hija: UX-P2 Nombres en vez de UUIDs

**Origen:** `odd/tasks/ux-propuestas.md` P2 + decisiones `odd/tasks/ux-review.md`.
**Principios:** cero UUID a mano; listas con nombres; selector con lista corta del alcance + buscador; español neutro.
**Reglas:** rama feature + commits unidad de trabajo (sin merge sin orden explícita). Scout propio antes de escribir código. No absorber P3 (portada/tableros). Decisión del usuario: P2-1 incluye el backend faltante (sedes, personas global, turnos) — primero endpoints, después selectores.

## Tareas
- [x] P2-0 Mapeo web (scout): inventario de formularios con UUID a mano + listas + contactos JSON + selectores reutilizables + plan P2-1..P2-4
- [x] P2-0b Mapeo backend (scout): org_nodes, users+memberships, cash_sessions y budget_lines existen en tablas sin endpoint GET; listInvoices ya existe (no crear). Patrón R1 keyset a copiar.
- [ ] P2-0c Backend (1/2): `GET /v1/org/nodes` + `GET /v1/users` con contratos + tests
- [ ] P2-0d Backend (2/2): `GET /v1/billing/cash-sessions` + `GET /v1/obras/sites/:siteId/budget-lines` con contratos + tests
- [ ] P2-1 Selectores con lista corta del alcance + buscador (persona, sede, equipo, ítem, turno, episodio)
- [ ] P2-2 Listas muestran nombres (paciente, profesional, sede); UUID como subtítulo tenue o fuera
- [ ] P2-3 Contactos dejan de ser JSON visible; signos con etiquetas en español (Presión, Pulso…)
- [ ] P2-4 Ningún formulario exige pegar un UUID a mano (cierre de los huecos de P2-1)
- [ ] P2-5 Cierre: suites en verde + clics por rol + aceptación P2

## Fuera
- P1 (en PR #9), P3-P7 (otras hijas)
- Rediseño de portada/tableros (P3)

## Evidencia
- (se registra por tarea: PR de P2 al cierre P2-5)
