# Feature: MVP2 Builder + BI

**Objetivo:** builder v1 (campos custom por módulo, estados de pipeline/obra/episodio, reglas de permiso por estado, vistas guardadas) + BI completa (tableros agregados por tenant).
**Alcance exacto:** se define tras el mapeo — builder total y BI completa son los ítems de mayor riesgo de alcance triple (propuesta §40); se corta en v1 útil y honesto.
**Predecesor:** notificaciones en main (PR #6).
**Reglas:** español neutro en docs, código en inglés, datos sintéticos. Sin commits sin orden explícita. Rama feature + commits unidad de trabajo cuando se autorice.

## Tareas (corte v1 aprobado por el usuario)
- [x] B0 Mapeo (scout muh6sp8-s-d80g)
- [x] B1 `saved_views` CRUD + `?saved_view_id=` en 4 listados y pantallas. Verde: API 605, web 125, contracts 141. Seguimiento: tests de resolución aplicada por entidad propuestos (salud-saved-views, billing, obras, views-listing) — pendientes para B6
- [x] B2 Campos custom (text|number|date|boolean + required) en contacts y triages.values, con render por tipo. Verde: API 620, contracts 148. Cableados padre
- [x] B3 Catálogo `state_transitions` (migración 009) + `assertTransition` en 3 call-sites sin cambio de comportamiento. Verde: API 626, contracts 155. Cableados + 009 en vivo + API reconstruido
- [x] B4 BI exportable: `?compare=` + export CSV en 3 tableros + tests (API 642, web 137)
- [x] B5 Matriz como datos + `GET /v1/policy/preview` + página `/politicas` (navHidden para no reescribir pins). Verde: API 656, contracts 164, web 137. Cableados padre
- [x] B6 Cierre: suites 656/164/137/60 + vivo (vistas CRUD, custom 400, policy preview, compare, CSV) + clics (matriz, selectores, comparativa UI). Incidente: dist viejo ocultó B4/B5 hasta rebuild. Verde tras rebuild

## Fuera inicial
- Builder visual total con logic builder (fase 2)
- Conector ERP/HCE nativo (se elige por cliente piloto)

## Evidencia
- (se registra por tarea: commits solo con orden explícita)
