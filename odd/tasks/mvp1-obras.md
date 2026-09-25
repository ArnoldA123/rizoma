# Feature: MVP1 Obras — ficha, personal, equipos, stock y avance

**Objetivo:** vertical construcción operando en local: ficha Obra 360,
cuadrillas y asignaciones, asistencia básica, equipos con horómetro manual,
stock y consumos, presupuesto vs avance, bitácora con fotos, importadores CSV
y tablero de obra.
**Fuentes:** bases-consolidadas-v1.md §2.4, §3.4, §6.2, §7.1.
**Predecesores:** F0 6/6, API runtime 4/4, MVP1 Salud 5/5 (patrones
establecidos: servicio plano + controllers finos + guard/policy/auditoría).
**Reglas:** sin commits sin orden explícita. Código en inglés, datos sintéticos.

## Tareas

- [x] O1 Migración 005 obras (sites, crews, assignments, attendance, assets,
  asset_readings, inventory_items, stock_moves, budget_lines,
  progress_entries, milestones, site_logs) con RLS + linter verde
- [x] O2 API obras+personal+asistencia (asignación activa como llave de acceso)
- [x] O3 Equipos+stock+presupuesto/avance+bitácora (consumo descuenta posted)
- [x] O4 Importadores CSV (trabajadores, equipos) + tablero obra + cierre

## Criterios de salida (base §7.1)

1. Trabajador fuera de obra o de baja no marca ni accede.
2. Jefe ve solo sus obras (prueba de alcance).
3. Consumo descuenta stock en posted.
4. Importadores CSV operativos. 5. Tablero con KPIs y caché.

## Evidencia

- Commits: (solo con orden explícita)
