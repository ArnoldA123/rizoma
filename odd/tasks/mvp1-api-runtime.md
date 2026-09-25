# Feature: API runtime base (puerta a MVP1)

**Objetivo:** servidor API NestJS corriendo en local: bootstrap + config por
entorno, health, contexto tenant (SET LOCAL vía PgBouncer), guard central
conectado con auditoría access.denied y revocación efectiva <5 min.
**Fuentes:** bases-consolidadas-v1.md §1.2, §3.1, §4.2, §5.1; f0-fundacion.md.
**Predecesor:** F0 cerrado (6/6). **Reglas:** sin commits sin orden explícita.
Identificadores y código en inglés. Tests con el runner del repo.

## Tareas

- [x] A1 Bootstrap NestJS (main, config, health, build verde)
- [x] A2 Contexto tenant (headers + SET LOCAL vía PgBouncer + checks PG/Redis; JWT pasa a A3)
- [x] A3 Guard conectado (JWT Keycloak + regla formal + access.denied auditado + TTL permisos)
- [x] A4 Medición revocación <5 min y probes login/facturación (cierra hueco F0)

## Criterios de salida

1. `GET /health` 200 con checks de PG y Redis.
2. Request sin tenant válido → 403 sin fugas.
3. Baja de membership revoca en <5 min medido.
4. Build + tests verdes en CI.

## Evidencia

- Commits: (solo con orden explícita)
