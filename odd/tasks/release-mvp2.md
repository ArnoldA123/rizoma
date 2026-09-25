# Feature: Release MVP2 — endurecimiento

**Objetivo:** dejar `main` en estado releasable: E2E de navegador, paginación por cursor en listados, caché Redis en tableros, y release versionado.
**Predecesor:** builder + BI en main (PR #7).
**Reglas:** español neutro en docs, código en inglés, datos sintéticos. Sin commits sin orden explícita. Rama feature + commits unidad de trabajo cuando se autorice.

## Tareas
- [x] R0 Mapeo (scout muhjgy3-11-2xxv): 10+ listados cap 200 sin cursor; tableros sin caché servidor (REDIS_CLIENT inyectable ya existe); e2e node --test sin Keycloak; CI sin job e2e ni suites; sin CHANGELOG/tags. Orden: R2 caché → R1 cursor → R3 E2E+CI → R4 versión
- [x] R1 Keyset en 6 listados (compat total, 400 ante cursor malo) + tests (API 693, contracts 173)
- [x] R2 Caché Redis en 3 tableros (900s salud/300s obras, fail-open, clave verificada en vivo). Verde: API 676
- [x] R3 Job `e2e` en CI (postgres+redis, migraciones 001-009, anti-enmascaramiento) + `docs/ci-e2e.md`. Se verifica en el primer run de CI
- [x] R4 Versiones 0.2.0 + CHANGELOG.md (tag tras el merge del PR)

## Fuera
- Réplica de lectura / `mart_*` (infra mayor, fase 2)
- PDF/XLSX (CSV ya existe)

## Evidencia
- (se registra por tarea: commits solo con orden explícita)
