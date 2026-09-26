# Feature hija: UX-P2 Nombres en vez de UUIDs

**Origen:** `odd/tasks/ux-propuestas.md` P2 + decisiones `odd/tasks/ux-review.md`.
**Principios:** cero UUID a mano; listas con nombres; selector con lista corta del alcance + buscador; español neutro.
**Reglas:** rama feature + commits unidad de trabajo (sin merge sin orden explícita). Scout propio antes de escribir código. No absorber P3 (portada/tableros). Decisión del usuario: P2-1 incluye el backend faltante (sedes, personas global, turnos) — primero endpoints, después selectores.

## Tareas
- [x] P2-0 Mapeo web (scout): inventario de formularios con UUID a mano + listas + contactos JSON + selectores reutilizables + plan P2-1..P2-4
- [x] P2-0b Mapeo backend (scout): org_nodes, users+memberships, cash_sessions y budget_lines existen en tablas sin endpoint GET; listInvoices ya existe (no crear). Patrón R1 keyset a copiar.
- [x] P2-0c Backend (1/2): `GET /v1/org/nodes` + `GET /v1/users` con contratos + tests. Verde: API 712, contracts 180. Verify PASS.
- [x] P2-0d Backend (2/2): `GET /v1/billing/cash-sessions` + `GET /v1/obras/progress/budget-lines?site=` con contratos + tests. Verde: API 729, contracts 186. Verify PASS. Ruta plana coherente con entries?site= del mismo controller.
- [x] P2-1a Base web: wrappers org/users/cash-sessions/budget-lines + EntitySelector (lista corta + buscador insensible a tildes). Verde: web 144, tsc limpio. Verify PASS.
- [x] P2-1b Salud: EntitySelector en appointment/patient/consent/triages/prescriptions/episodes/invoice-issue/quotes/cash-session + filtros caja/role-board. Verde: web 144, tsc limpio. Verify PASS. Nota de tamaño: 493+/304- en una unidad (11 archivos, mismo patrón mecánico, revisión archivo por archivo).
- [x] P2-1c Obras: EntitySelector en site-form/staff/stock/assets/progress/imports. Verde: web 144, tsc limpio. Verify PASS. Excepciones: crewId (sin endpoint cuadrillas) y lookupId job (sin listado) quedan para P2-4.
- [x] P2-2a Listas salud con nombres (agenda-board, patient-file citas, episodes-panel, caja-board, invoice-detail-panel, quotes-panel, cash-session-panel). Verde: web 144, tsc limpio. Verify PASS (nombres resueltos en navegador con respaldo a id corto).
- [x] P2-2b Listas obras con nombres (attendance, staff, assets, stock, progress, logs, sites-browser, site-file). Verde: web 144, tsc limpio. Verify PASS.
- [ ] P2-2 Listas muestran nombres (paciente, profesional, sede); UUID como subtítulo tenue o fuera
- [x] P2-3 Contactos sin JSON + signos con etiquetas en español (patient-file, triages-panel). Verde: web 144, tsc limpio. Verify PASS.
- [x] P2-4a Backend remanentes: `GET /v1/obras/crews` + `GET /v1/imports/jobs` con contratos + tests. Verde: API 744, contracts 190. Verify PASS.
- [x] P2-4b Web remanentes + cierre: crewId y lookupId con EntitySelector (respaldo a mano solo si la lista de jobs falla, con aviso) + wrappers listCrews/listImportJobs + tests. Verde: web 146, tsc limpio. Verify PASS (cero UUID a mano salvo respaldo condicional y adjuntos).
- [x] P2-5 Cierre: suites API 744 + contracts 190 + web 146 en verde; aceptación P2 cumplida con 2 excepciones documentadas (attachmentIds sin endpoint con nombre; respaldo jobListFailed). Excepción inicial corregida (sede salud).
- [ ] P2-5 Cierre: suites en verde + clics por rol + aceptación P2

## Fuera
- P1 (en PR #9), P3-P7 (otras hijas)
- Rediseño de portada/tableros (P3)

## Evidencia
- (se registra por tarea: PR de P2 al cierre P2-5)
