# Feature: F0 Fundación — base construible CRM maleable Perú

**Objetivo:** levantar la fundación ejecutable del CRM maleable: monorepo + Compose local (PG16, PgBouncer, Redis, Keycloak, MinIO), migración 001 con RLS, auth MFA + guard RBAC/alcance/estado, onboarding first-run, archivos con hash, outbox + colas y factura con switch SUNAT.
**Fuentes base:**
- `docs/crm-maleable/propuesta-v1.md` §17 (F0 3-4 sem)
- `docs/crm-maleable/bases-consolidadas-v1.md` §7.1 (criterios de salida F0)
- `docs/crm-maleable/peru-anexo-v1.md` §3-§6, §11 (factura manual + switch SUNAT + onboarding)
**Decisiones sesión 2026-09-24:**
- SUNAT: beta desde F0 (adaptador `sunat_v1` con cola + `contingency`, manual `INT-XXX` por defecto)
- Datos demo: sintéticos (RUC 20123456789, razón social ficticia, correos ficticios)
- Entorno: Docker local en WSL (Ubuntu 26.04, sin Docker aún — instalar antes de T1)
**Reglas:** español neutro en docs, identificadores y código en inglés. Sin commits sin orden explícita. Commits unidad de trabajo por tarea en rama feature cuando se autorice.

## Tareas

- [x] T1 Monorepo + Compose (PG16, PgBouncer transaction, Redis 7, Keycloak 25+, MinIO) + CI base 2 entornos
- [x] T2 Migración 001 core (tenants, org_nodes, users, memberships, roles, audit_log, outbox, documents/attachments, idempotency_keys, dispositivos mínimos) con RLS `FORCE` + linter (sin `tenant_id` o sin policy rompe build) + test aislamiento 2 tenants
- [x] T3 Auth (guard+tests; revocación <5min se mide con API en T4) Keycloak OIDC + MFA TOTP + guard central RBAC + alcance (subárbol org) + estado + `access.denied` auditado; baja revoca <5 min
- [x] T4 Onboarding first-run (disparo BD vacía, 7 pasos §11 anexo, RUC verificador, acta inmutable, `onboarding_pending` hasta cierre, idempotente reanudable)
- [x] T5 Archivos S3-compatible (prefijo tenant, sha256, MIME+antivirus, URL firmada ≤5 min) + outbox → BullMQ + `FiscalAdapter` (`manual_v1` + `sunat_v1` beta, reintentos 1m/5m/30m/2h/6h, `contingency`, payload crudo inmutable) + vault secretos (envelope AES-256-GCM, cero secretos en logs/backups)
- [x] T6 Observabilidad OTel + probes sintéticos (login, agenda, facturación) + restore drill documentado + verificación criterios de salida F0

## Criterios de salida F0 (duros, de bases §7.1)

1. Test aislamiento entre 2 tenants en CI pasa.
2. Migración sin `tenant_id` o sin policy rompe la build.
3. Baja de membership revoca acceso en <5 min medido.
4. Restore drill ejecutado y documentado.
5. 99.5% medible en horario laboral con probes.
6. SUNAT beta: activación/validación/revocación probadas sin bloquear caja; ningún secreto en claro (búsqueda negativa).
7. Onboarding con sintéticos cierra acta y desbloquea rutas.

## Evidencia

- Commits: (solo con orden explícita del usuario)
- Docs: este archivo + `odd/tasks/crm-bases.md`, `odd/tasks/crm-peru.md` (cerrados)
