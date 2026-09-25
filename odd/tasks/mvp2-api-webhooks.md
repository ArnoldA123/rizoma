# Feature: MVP2 API pública + webhooks

**Objetivo:** exponer API pública con claves de API y webhooks firmados con reintentos observables, sobre la base F0 (outbox + BullMQ ya existen).
**Por qué primero:** es la base de los otros tracks (notificaciones y builder consumen este mismo patrón de entrega); no requiere proveedores externos ni credenciales de pago.
**Fuentes:** bases-consolidadas-v1.md §5 (integraciones), §7.1 MVP2 (criterios 2 y 4).
**Reglas:** español neutro en docs, código en inglés, datos sintéticos. Sin commits sin orden explícita. Rama feature + commits unidad de trabajo cuando se autorice.

## Tareas
- [x] W0 Mapeo (scout muh9hr-i-alsq): sin rastro de api-key; workers con config de colas pero sin runtime BullMQ; usage_counters ausente en código; eventos candidatos factura/stock/onboarding con `writeAudit` como punto de piggyback. Migraciones viven en `db/migrations/*.sql` (fuera del índice TS)
  - Orden: W1 auth API-key → W2 outbox+webhooks → W3 eventos → W4 docs → W5 cierre
- [x] W1 Claves de API: migración 006 + rama X-Api-Key + gestión admin + contratos. Verde: API 509, contracts 107. Cableados padre + 006 aplicada en vivo + API reconstruido (403 tipificado en vivo)
- [x] W2 Webhooks: migración 007 + CRUD suscripciones + outbox writer + runtime BullMQ con HMAC + piggyback en issue/pay/void. Verde: API 537, contracts 115, workers 37. Cableados padre + 007 en vivo + API reconstruido (403 tipificado en vivo)
- [x] W3 Eventos + uso: stock.posted|reversed cableados, onboarding.closed listo para provisioning, 008 + conteo en middleware (cliente corto). Verde: API 552. Pulido padre: test de conteo en middleware + API reconstruido
- [x] W4 Docs: `docs/api-publica/openapi.yaml` (7 paths/10 ops verificadas) + `guia.md`. Sin endpoint público de uso (declarado)
- [x] W5 Cierre: e2e viva con clave máquina (`X-Api-Key` → 200 + fila en `usage_counters` count 2) y luego revocada. Pulido padre: piggyback facturación, conteo en middleware, 006/007/008 en loops y en vivo, suites y API reconstruidos

## Criterios de salida (bases §7.1 adaptados)
1. Webhooks firmados con reintentos observables.
2. Revocación de clave efectiva en <5 min.
3. Facturación por uso conciliada con `usage_counters` (base).

## Evidencia
- (se registra por tarea: commits solo con orden explícita)
