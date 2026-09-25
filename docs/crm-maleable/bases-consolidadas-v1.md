# CRM Maleable Multivertical — Bases consolidadas v1

**Estado:** diseño construible. Sin código.
**Fuente:** `docs/crm-maleable/propuesta-v1.md` (consolidada; este documento la reemplaza como referencia de construcción).
**Alcance:** fijar módulos, permisos, datos, API, UX y fases del MVP Salud + Construcción sin huecos para iniciar obra.
**Escala objetivo v1:** 2.000–10.000 usuarios, ~1.000 concurrentes, SLA 99.5% en horario laboral (07:00–20:00 del país elegido).
**Idioma de artefactos técnicos:** español neutro. Identificadores, código y nombres de tabla en inglés.
**Reglas de esta fase:** solo análisis y diseño, sin código, sin commits.

## 1. Decisiones fijadas (base de todo lo que sigue)

| # | Dimensión | Decisión fijada | Sección que la resuelve |
|---|-----------|-----------------|--------------------------|
| 1 | Verticales piloto | Salud + Construcción, fichas separadas | §2.3, §2.4, §8 |
| 2 | Topología | Híbrido: shared por defecto, dedicado para tenant regulado | §1.1 |
| 3 | Escala | 2k–10k usuarios, 1k concurrentes | §6.3, §7.5 |
| 4 | Seguridad | Máxima regulada | §4.4–§4.7, §5 |
| 5 | Core | Full + facturación electrónica de un país + inventario + asistencia básica | §2.2–§2.6, §8 |
| 6 | BD | Postgres 16 compartido con RLS por tenant | §4.1–§4.3 |
| 7 | Permisos | RBAC + alcance (empresa/sede/área/proyecto) + estado activo/baja | §3.1–§3.5 |
| 8 | UX | Módulos activables + white-label + builder limitado a campos/estados/flujos/permisos | §6.4 |
| 9 | Integraciones | API-first; adaptadores; no todos los conectores construidos en MVP1 | §5.1–§5.4 |
| 10 | Campo/IoT | Solo web en MVP; API idempotente + outbox + colas listas para offline/IoT | §2.6, §4.2, §5.1 |
| 11 | Cobro | Base + módulo + uso, medido desde v1 | §2.1, §4.6, §7.1 |
| 12 | Stack | TS + NestJS + Next.js + Postgres 16 + Redis + Keycloak + Hetzner + Cloudflare | §1.2 |
| 13 | SLA | 99.5% en horario laboral | §7.1, §6.3 |

### 1.1 Topologías (dos, mismo binario)

| Topología | Cuándo | Postgres | Bucket | Bandera | Consecuencia operativa |
|-----------|--------|----------|--------|---------|------------------------|
| Shared | Resto de tenants | Cluster común + RLS | Bucket común con prefijo por tenant | `tenant.isolated=false` | Un despliegue, costo bajo, aislamiento lógico |
| Dedicated | Clínica/empresa regulada que lo exija | Instancia propia | Bucket propio | `tenant.isolated=true` | `DATABASE_URL` y bucket resueltos por `tenant_id`; duplicar stack mínimo |

Regla dura: el código no cambia entre topologías; cambia el binding de infraestructura (ADR-002).

### 1.2 Stack fijado

| Capa | Elección | Versión base |
|------|----------|--------------|
| Lenguaje | TypeScript | 5.6+ / Node 22 LTS |
| Backend | NestJS + REST + validación Zod | Nest 11 |
| Frontend | Next.js + React + Tailwind + shadcn/ui | Next 15, React 19 |
| ORM | Drizzle + SQL directo para RLS | actual |
| Auth | Keycloak self-hosted (OIDC) + MFA TOTP/WebAuthn | 25+ |
| BD | Postgres 16 + PgBouncer (transaction mode) + réplica lectura | 16 |
| Caché/colas | Redis 7 + BullMQ | 7 |
| Archivos | S3-compatible (R2/MinIO) | — |
| Observabilidad | OpenTelemetry + Prometheus + Loki + Uptime | — |
| IaC | Terraform + Ansible + GitHub Actions | — |
| Infra | Hetzner + Cloudflare (DNS/CDN/WAF/Tunnel) | — |

Estructura de repos: `apps/web`, `apps/api`, `apps/workers`, `packages/ui`, `packages/config`, `packages/contracts`, `infra/terraform`, `docs/`.

## 2. T1 — Módulos, entidades, campos, estados y exclusiones

### 2.1 Módulos y activación

| Módulo | Código | Depende de | MVP1 | Billing |
|--------|--------|------------|------|---------|
| Core CRM | `crm-core` | — | Sí (siempre) | base |
| Salud | `salud` | crm-core, docs, billing | Sí (tenant salud) | +módulo |
| Obras | `obras` | crm-core, inventario, asistencia | Sí (tenant construcción) | +módulo |
| Inventario/Activos | `inventario` | crm-core | Sí | +módulo |
| Asistencia | `asistencia` | crm-core, org | Sí (básica) | +uso (marcas) |
| Facturación | `facturacion` | crm-core, adaptador fiscal | Sí (un país) | +uso (folios) |
| Reportes/BI | `reportes` | todos | Sí (mínimo viable) | base / +uso |
| Builder | `builder` | crm-core | Sí (limitado) | plan alto |
| Notificaciones | `notify` | crm-core | Sí (email; WhatsApp/SMS en MVP2) | +uso |
| Campo/IoT | `campo` | obras, telemetría | **No** | fase 2 |

Activación por `tenant.modules[]` + feature flags por entorno. Sin forks de código.

### 2.2 Core CRM (`crm-core`)

| Entidad | Campos mínimos | Estados y transiciones | Dependencias | Excluido MVP1 |
|---------|----------------|------------------------|--------------|---------------|
| `tenants` | id, name, plan, isolated, country, locale, theme, modules[], status | `active→suspended→active`; `*→cancelled` (solo lógico) | — | multi-moneda, multi-país fiscal |
| `org_nodes` | id, tenant_id, parent_id, kind, name, active | `active↔inactive` | tenants | más de 3 niveles de profundidad en UI |
| `users` | id, tenant_id, name, email, phone, active, mfa_enrolled | `invited→active→suspended→offboarded` | tenants | SCIM/SSO para todos los planes |
| `memberships` | user_id, tenant_id, org_node_id, role, scopes[], active, valid_from, valid_to | `active↔inactive`; vencimiento por `valid_to` | users, roles, org_nodes | herencia automática sin asignación explícita |
| `roles` | code, tenant_id, vertical, permissions[] | `draft→active→retired` | tenants | editor visual de roles (solo builder de reglas) |
| `persons` / `companies` | id, tenant_id, kind, name, tax_id, contacts[], active | `active→merged→inactive` | tenants | deduplicación automática |
| `deals` | id, tenant_id, org_node_id, person/company_id, stage_id, owner, amount, closed_at | Pipeline configurable `new→qualified→proposal→won` / `lost` | persons/companies, `deal_stages` | forecasting estadístico |
| `deal_stages` | id, tenant_id, vertical, code, order, active | `active↔inactive` | tenants | — |
| `documents` / `attachments` | id, tenant_id, owner_type, owner_id, bucket_key, sha256, mime, size, retention_until, status | `quarantined→available→expired`; purga solo programada | outbox, storage | firma digital avanzada |
| `audit_log` | id, tenant_id, actor, action, entity, entity_id, org_node_id, diff, ip, at | Append-only, sin transiciones | todos | — |
| `outbox` | id, tenant_id, aggregate, event, payload, occurred_at, dispatched_at | `pending→dispatched→failed` | — | — |
| `usage_counters` | tenant_id, metric, period, qty | `open→closed` | workers | facturación por uso automatizada (MVP1 registra) |

### 2.3 Salud (`salud`)

| Entidad | Campos mínimos | Estados y transiciones | Dependencias | Excluido MVP1 |
|---------|----------------|------------------------|--------------|---------------|
| `patient_files` | id, tenant_id, org_node_id (sede), person_id, document_id, birthdate, allergies[], alerts[], contacts[], active | `draft→active→merged→inactive` (nunca borrado físico) | persons, documents | portal del paciente |
| `episodes` | id, tenant_id, patient_id, especialidad, opened_at, closed_at, status, professional_id | `open→closed` / `cancelled` | patient_files | diagnóstico estructurado CIE completo |
| `appointments` | id, tenant_id, org_node_id, patient_id, professional_id, starts_at, duration, status | `scheduled→confirmed→checked_in→in_care→completed`; `no_show`, `cancelled` | episodes, org_nodes | recordatorios automáticos multi-canal |
| `triages` / `vitals` | id, tenant_id, patient_id, episode_id, recorded_by, values JSONB, at | Solo inserción (corrección = nueva versión) | episodes | escalas clínicas automáticas |
| `consents` | id, tenant_id, patient_id, template_code, version, signed_at, evidence_attachment_id, status | `pending→signed→revoked` / `expired` | documents | firma electrónica certificada por tercero |
| `prescriptions` / `orders` | id, tenant_id, patient_id, episode_id, template_code, items JSONB, status | `draft→issued→cancelled` | episodes | HCE completa, dosificación e interacciones |
| `cash_sessions` | id, tenant_id, org_node_id, opened_by, opened_at, closed_at, totals | `open→closed` | invoices, payments | arqueo con hardware |

### 2.4 Obras (`obras`)

| Entidad | Campos mínimos | Estados y transiciones | Dependencias | Excluido MVP1 |
|---------|----------------|------------------------|--------------|---------------|
| `sites` (obra/proyecto) | id, tenant_id, org_node_id, code, name, client_id, budget_total, started_at, ended_at, status | `planned→active→suspended→closing→closed` / `cancelled` | org_nodes, companies | Gantt y ruta crítica |
| `crews` | id, tenant_id, org_node_id, name, lead_membership_id, active | `active↔inactive` | memberships | — |
| `assignments` | id, tenant_id, user_id, site_id, crew_id, role_in_site, active, valid_from, valid_to | `active↔ended` (fin por `valid_to` o baja) | users, sites, crews | asignación por turnos |
| `attendance` | id, tenant_id, user_id, site_id, check_in, check_out, source, status, approved_by | `registered→approved` / `rejected` / `adjusted` | assignments | geocerca y biometría (fase 2) |
| `assets` (equipos/maquinaria) | id, tenant_id, org_node_id, code, kind, plate/serial, status, current_site_id | `available→assigned→maintenance→retired` | inventory_items | telemetría IoT |
| `asset_readings` | id, tenant_id, asset_id, kind, value, at, source | Solo inserción (horómetro manual en MVP) | assets | lectura automática MQTT |
| `inventory_items` | id, tenant_id, sku, name, unit, min_stock, active | `active↔inactive` | tenants | variantes complejas |
| `stock_moves` | id, tenant_id, item_id, warehouse_node_id, site_id, qty, kind, at, status | `draft→posted→reversed` | inventory_items, org_nodes | valorización contable avanzada |
| `budget_lines` | id, tenant_id, site_id, item_id, qty_planned, unit_cost | `active↔inactive` | sites | versionado de presupuesto |
| `progress_entries` | id, tenant_id, site_id, budget_line_id, qty_done, at, reported_by, status | `draft→posted` | budget_lines | curva S automática |
| `milestones` | id, tenant_id, site_id, name, due_at, status | `pending→done` / `late` | sites | dependencias entre hitos |
| `site_logs` (bitácora) | id, tenant_id, site_id, author_id, text, attachments[], at, status | `draft→published` | documents | captura offline con fotos (fase 2) |

### 2.5 Transversales

| Entidad | Campos mínimos | Estados y transiciones | Dependencias | Excluido MVP1 |
|---------|----------------|------------------------|--------------|---------------|
| `quotes` | id, tenant_id, org_node_id, person/company_id, items JSONB, total, valid_until, status | `draft→sent→accepted` / `rejected` / `expired` | persons/companies | firma de cotización |
| `invoices` | id, tenant_id, org_node_id, quotes_id, total, tax_total, fiscal_status, fiscal_adapter, fiscal_payload | `draft→issued→paid` / `partially_paid` / `voided`; fiscal `pending→sent→accepted` / `rejected` / `contingency` | quotes, adaptador fiscal | multi-país, retenciones |
| `payments` | id, tenant_id, invoice_id, method, amount, at, external_ref, status | `registered→reconciled` / `reversed` | invoices | conciliación bancaria automática |
| `usage_metrics` | tenant_id, metric, qty, source_event_id, at | Solo inserción | outbox | — |
| `message_log` | id, tenant_id, channel, template, to, status, cost, provider_ref | `queued→sent→delivered` / `failed` | notify | WhatsApp/SMS plenos (MVP2) |
| `notify_templates` | id, tenant_id, channel, code, version, body, approved | `draft→active→retired` | tenants | editor visual de plantillas |
| `custom_field_defs` | id, tenant_id, module, entity, code, type, required, active | `draft→active→retired` | builder | campos calculados complejos |
| `saved_views` | id, tenant_id, user_id, entity, filters JSONB, shared | `active↔inactive` | — | — |
| `import_jobs` | id, tenant_id, kind, file_id, status, rows_ok, rows_error, errors_file_id | `queued→running→completed` / `failed` | attachments | importación incremental/schedulada |

### 2.6 Exclusiones explícitas de MVP1

| Excluido de MVP1 | Motivo | Fase |
|------------------|--------|------|
| App móvil nativa y offline total | Solo web; la base (outbox, Idempotency-Key, `sync_token`) queda lista | F2 Campo |
| Telemetría IoT productiva | Sin sensores ni MQTT en MVP | F2 IoT |
| Builder visual total y conector nativo ERP/HCE | Riesgo de alcance triple (decisión 8); API + webhooks + CSV cubren MVP1 | fase 2 / MVP2 |
| Multi-país fiscal | Un país primero (decisión 21) | fase 2 |
| HCE completa, geocerca, turnos y biometría | Plantilla de receta y asistencia básica alcanzan MVP1 (decisión 18) | fase 2 |

## 3. T2 — Permisos: RBAC + alcance + estado

### 3.1 Regla formal

```
allow(user, action, entity) =
      user.active = true
  AND membership.active = true
  AND now BETWEEN membership.valid_from AND COALESCE(membership.valid_to, 'infinity')
  AND entity.org_node_id ∈ subtree(membership.org_node_id)
  AND role.permits(action) = true
  AND state(entity).allows(action) = true
  AND action.module ∈ tenant.modules
```

Propiedades del modelo:

1. **Denegar por defecto.** Sin coincidencia completa la respuesta es `403`; no existe camino de permiso implícito.
2. Un solo guard central evalúa la regla; ningún endpoint hace chequeos sueltos.
3. Alcance = subárbol del `org_node` de la membership; `scopes[]` solo puede restringir, nunca ampliar.
4. `state(entity).allows(action)` bloquea escritura en entidades cerradas, anuladas o de baja.
5. La baja del usuario o de la membership revoca en menos de 5 minutos (sin caché larga de permisos).
6. Toda denegación se audita con `trace_id`, actor, acción y entidad.

### 3.2 Roles base

| Vertical | Roles |
|----------|-------|
| Salud | `ti_admin`, `direccion`, `medico`, `enfermeria`, `recepcion`, `caja`, `auditor` |
| Construcción | `gerente`, `jefe_obra`, `almacen`, `capataz`, `trabajador`, `auditor` |
| Transversal | `vendedor`, `soporte` |

### 3.3 Matriz clínica (extracto normativo)

| Acción | ti_admin | direccion | medico | enfermeria | recepcion | caja | auditor |
|--------|----------|-----------|--------|------------|-----------|------|---------|
| Ver agenda de sede | sí | sí (empresa) | sí (propia) | sí (sede) | sí (sede) | no | sí (solo lectura) |
| Ver historia clínica | no | no | sí (sus pacientes) | sí (sede, lectura) | no | no | no |
| Editar diagnóstico/episodio | no | no | sí (sus pacientes) | no | no | no | no |
| Registrar triaje/signos | no | no | sí | sí (sede) | no | no | no |
| Registrar consentimiento | no | no | sí | sí | sí | no | no |
| Ver montos y caja | no | sí (empresa) | no | no | no | sí (sede) | no |
| Cobrar / emitir factura | no | no | no | no | no | sí (sede) | no |
| Anular / nota de crédito | no | no | no | no | no | sí (con aprobación) | no |
| Administrar usuarios y roles | sí | no | no | no | no | no | no |
| Exportar masivo | no | no | no | no | no | no | no |
| Ver audit log | sí | no | no | no | no | no | sí (empresa, lectura) |

### 3.4 Matriz obra (extracto normativo)

| Acción | gerente | jefe_obra | almacen | capataz | trabajador | auditor |
|--------|---------|-----------|---------|---------|------------|---------|
| Ver obra | sí (empresa) | sí (sus obras) | sí (sus almacenes) | sí (su obra) | sí (asignado + activo) | sí (solo lectura) |
| Crear / editar obra | sí | no | no | no | no | no |
| Asignar trabajadores a obra | sí | sí (sus obras) | no | no | no | no |
| Marcar asistencia propia | sí | sí | sí | sí | sí (solo propia) | no |
| Aprobar asistencia de terceros | sí | sí (sus obras) | no | sí (su cuadrilla) | no | no |
| Ver / editar stock | sí | sí (lectura) | sí | no | no | sí (lectura) |
| Registrar consumo de materiales | sí | sí | sí | sí (su obra) | no | no |
| Registrar horómetro / equipo | sí | sí (sus obras) | sí | no | no | no |
| Ver presupuesto vs real | sí | sí (sus obras) | no | no | no | sí (lectura) |
| Emitir factura | no | no | no | no | no | no |
| Exportar masivo | no | no | no | no | no | no |

### 3.5 Ejemplos de denegación (obligatorios en pruebas)

| Caso | Resultado | Causa evaluada |
|------|-----------|----------------|
| Recepción intenta abrir historia clínica | `403` + `access.denied` | `role.permits = false` |
| Médico con membership `active=false` (baja) intenta atender cita | `403` + `access.denied` | `membership.active = false` |
| Usuario dado de baja (`users.active=false`) con token vigente intenta listar pacientes | `403` + `access.denied` | `user.active = false`, revocado en <5 min |
| Caja de sede A consulta caja de sede B | `403` + `access.denied` | `org_node_id ∉ subtree(membership)` |
| Trabajador asignado a obra A marca asistencia en obra B | `403` + `access.denied` | `org_node_id ∉ subtree` y asignación inexistente |
| Jefe de obra A abre ficha de obra B | `403` + `access.denied` | fuera de alcance |
| Cualquiera edita una factura en estado `voided` | `409` / `403` | `state(entity).allows = false` |
| Tenant sin módulo `salud` llama `/v1/salud/patients` | `403` + `access.denied` | `module ∉ tenant.modules` |
| Almacén intenta aprobar sueldos de asistencia de terceros | `403` + `access.denied` | `role.permits = false` |
| Auditor intenta escribir cualquier entidad | `403` + `access.denied` | rol de solo lectura |

## 4. T3 — Datos, RLS, auditoría, archivos y analítica

### 4.1 Reglas fundacionales

1. Toda tabla de negocio tiene `tenant_id UUID NOT NULL` y FK a `tenants(id)`.
2. Toda tabla de negocio tiene RLS habilitado y policy `tenant_isolation`.
3. Todo índice de negocio comienza por `tenant_id`.
4. Sin policy no hay despliegue: el linter de migraciones falla la CI.

Tablas fundacionales (v1): `tenants`, `org_nodes`, `users`, `memberships`, `roles`, `role_bindings`, `audit_log`, `outbox`, `usage_counters`, `documents`, `attachments`, `custom_field_defs`, `saved_views`, `import_jobs`, `message_log`, `notify_templates`, `devices`, `telemetry_events`, `visits`, `checkins` (las cinco últimas creadas mínimas y vacías desde fundación).

### 4.2 Patrón RLS (real)

```sql
ALTER TABLE patient_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_files FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON patient_files
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

Contrato de conexión por request: `SET LOCAL app.tenant_id`, `SET LOCAL app.user_id`, `SET LOCAL app.scopes` dentro de la transacción, vía PgBouncer en modo `transaction` (compatible con `SET LOCAL`). Tenant `isolated=true`: `DATABASE_URL` distinta resuelta por `tenant_id`.

### 4.3 Índices mínimos

| Patrón | Uso |
|--------|-----|
| `(tenant_id, id)` | PK compuesta lógica y lookups |
| `(tenant_id, org_node_id, created_at DESC)` | listados por sede/obra |
| `(tenant_id, active) WHERE active` | índices parciales de vigencia |
| `(tenant_id, site_id, at DESC)` | asistencia, bitácora, lecturas |
| `(tenant_id, status, at DESC)` | colas operativas |
| `(tenant_id, person_id)` / `(tenant_id, site_id)` | búsquedas de ficha |
| GIN sobre JSONB solo en `values`, `items`, `diff`, `filters` | campos dinámicos del builder |
| UNIQUE `(tenant_id, code)` en catálogos | integridad por tenant |

### 4.4 Auditoría (append-only)

* `audit_log` sin `UPDATE` ni `DELETE` para el rol de aplicación; permisos revocados en migración.
* Toda denegación de permiso escribe `access.denied` con `trace_id`.
* Hash encadenado opcional (`prev_hash`, `hash`) para inmutabilidad demostrable.
* Cambios sobre datos regulados incluyen `diff` JSONB y `org_node_id` del actor.

### 4.5 Archivos

| Aspecto | Regla |
|---------|-------|
| Ruta | `tenant/{tenant_id}/{module}/{yyyy}/{mm}/{uuid}` |
| Validación | MIME declarado vs detectado + antivirus antes de `available` |
| Integridad | `sha256` obligatorio; descarga verificada contra hash |
| Acceso | URL firmada de vida corta (≤5 min); prohibida URL pública permanente en salud |
| Retención | `retention_until` por dominio; purga solo por job aprobado |
| Metadatos | `owner_type`, `owner_id`, `uploaded_by`, `at` en `attachments` |

### 4.6 Analítica, réplica y caché

* Réplica de lectura Postgres para reportes y BI; las APIs de escritura nunca leen de la réplica.
* Vistas materializadas + caché Redis 5–15 min por tablero.
* `usage_counters` y `usage_metrics` se escriben desde workers, nunca en el request caliente.
* ETL nocturno a `mart_*`; ClickHouse/DuckDB solo si el BI crece.

### 4.7 Backups, PITR y retención

| Dato | PITR | Snapshot | Retención | Notas |
|------|------|----------|-----------|-------|
| Transaccional | 7–30 días según plan | Diario inmutable | Según plan | Restore drill mensual documentado |
| Salud (ficha, episodios, consentimientos) | 30 días | Diario | 5–10 años según normativa del país | Borrado solo lógico + purga aprobada |
| Fiscal (facturas, pagos, payload) | 30 días | Diario | Según ente tributario del país | Payload fiscal crudo inmutable |
| Auditoría | 30 días | Diario | Igual o mayor que salud | Append-only, cifrado |
| Archivos (bucket) | — | Versionado | Igual que su dominio | Backups cifrados, bitácora de acceso |

Datos y backups residen en la jurisdicción del país elegido (cláusula contractual).

## 5. T4 — API, integraciones, idempotencia y webhooks

### 5.1 Convenciones REST `/v1`

| Aspecto | Regla |
|---------|-------|
| Rutas | `/{v1}/{modulo}/{recurso}`; `tenant_scope` se deriva del token, nunca del query |
| Contrato | OpenAPI generado desde `packages/contracts` (Zod) |
| Idempotencia | `Idempotency-Key` obligatorio en todo `POST` crítico (cobros, facturas, asistencia, importaciones) |
| Semántica idempotente | Misma clave + mismo body → misma respuesta; misma clave + body distinto → `409 idempotency_conflict` |
| Ventana de clave | 24 h persistida en `idempotency_keys(tenant_id, key, request_hash, response, expires_at)` |
| Paginación | Cursor: `?limit=50&cursor=...`; respuesta `{data[], next_cursor}` |
| Filtrado | `?filters[...]`, `?sort=`, `?saved_view_id=` para vistas del builder |
| Errores | `{code, message, traceId, details?}`; `traceId` igual al de logs y trazas OTel |
| Versionado | Sin cambios de contrato dentro de `/v1`; deprecación anunciada con cabecera |
| Rate-limit | Por tenant + IP, límites por plan |
| Autenticación | OIDC para usuarios; API keys por tenant con `scopes[]` para integraciones |

### 5.2 Webhooks salientes

| Aspecto | Regla |
|---------|-------|
| Firma | `X-Signature: hmac-sha256=<hex>` sobre timestamp + body |
| Replay | `X-Timestamp` con tolerancia de 5 min; rechazo si está fuera de ventana |
| Reintentos | Backoff exponencial 5 intentos (1 m, 5 m, 30 m, 2 h, 6 h) |
| Entrega | At-least-once; el consumidor debe ser idempotente con `event_id` |
| Observabilidad | `webhook_deliveries` con estado, intentos y último error |

### 5.3 Adaptadores con reintentos y modo degradado

| Adaptador | Interfaz | Reintentos | Modo degradado |
|-----------|----------|------------|----------------|
| `notify.send(to, channel, template)` | Email / WhatsApp / SMS | 3 intentos, backoff 1 m / 10 m / 1 h | Encola y notifica en panel; no bloquea el flujo clínico |
| `FiscalAdapter.emit(invoice) -> folio/status` | Un país | 5 intentos, backoff 1 m / 5 m / 30 m / 2 h / 6 h | Emite comprobante interno con `fiscal_status=contingency` y reintenta; nunca bloquea la atención |

Reglas: el core nunca contiene lógica fiscal ni de proveedor; todo payload fiscal crudo se guarda para auditoría; los workers son los únicos que llaman adaptadores.

### 5.4 Importadores CSV (MVP1)

| Importador | Entidad destino | Reglas |
|------------|-----------------|--------|
| Pacientes | `patient_files` + `persons` | Validación de documento, sede y consentimiento inicial marcado como pendiente |
| Trabajadores | `users` + `memberships` | Requiere rol y `org_node`; alta masiva con `active=false` por defecto |
| Equipos/activos | `assets` | Código único por tenant; crea `asset_readings` solo si hay horómetro inicial |
| Ítems de inventario | `inventory_items` | SKU único por tenant; stock inicial vía `stock_moves` `posted` |
| Catálogo de precios | `quotes`/`invoices` (items) | Solo catálogo; no emite documentos fiscales |

Contrato del importador: `import_jobs` con `rows_ok`, `rows_error` y archivo de errores descargable; toda importación es idempotente por hash del archivo.

## 6. T5 — UX, fichas, tableros y builder

### 6.1 Ficha Paciente 360

| Bloque | Contenido | Regla de visibilidad |
|--------|-----------|----------------------|
| Cabecera | Identidad, sede, especialidad, alertas/alergias | Según alcance de sede |
| Consentimientos | Estado, versión, evidencia, vencimiento | Recepción ve estado, no contenido clínico |
| Episodios | Abiertos y cerrados, timeline | Solo médico/enfermería con permiso |
| Citas | Próximas y pasadas, estados | Recepción, médico, enfermería |
| Documentos | Adjuntos con retención y hash | Según módulo y permiso |
| Cuenta y facturación | Cobros, facturas, saldo | Solo caja/dirección |

### 6.2 Ficha Obra 360

| Bloque | Contenido | Regla de visibilidad |
|--------|-----------|----------------------|
| Cabecera | Código, cliente, estado, fechas, presupuesto total | Alcance de empresa/obra |
| Personal | Asignaciones activas e historial | Jefe de obra, gerente |
| Asistencia | Marcas por día, aprobaciones | Jefe, capataz; trabajador solo las propias |
| Equipos | Activos asignados, horómetro | Jefe, almacén |
| Stock y consumos | Movimientos por almacén y obra | Almacén, jefe |
| Avance y presupuesto | Planificado vs real por partida | Jefe, gerente, auditor (lectura) |
| Bitácora | Entradas con fotos y hitos | Todos los asignados a la obra |
| Documentos | Planos, permisos, actas | Según permiso |

Fichas separadas con componentes compartidos (timeline, archivos, tareas, cobros) y bloques distintos (ADR-005).

### 6.3 Tableros por rol

| Rol | KPIs principales | Refresco |
|-----|------------------|----------|
| Recepción | Citas del día, espera promedio, inasistencias, pacientes en cola | 1–5 min |
| Caja | Cobros del día, facturas emitidas, pendientes fiscales, arqueo | 1–5 min |
| Médico | Mis citas, episodios abiertos, consentimientos pendientes | 5 min |
| Jefe de obra | Avance por partida, asistencia del día, stock crítico, equipos en mantenimiento | 5–15 min |
| Gerencia | Embudo, cobranza, avance global, uso por módulo | 15 min |
| Auditor | Eventos denegados, accesos a historia, cambios sensibles | 15 min |
| ti_admin | Salud del tenant, módulos activos, errores 5xx, edad de backup | 5 min |

Los tableros leen de la réplica de lectura con caché Redis 5–15 min; nunca del primario.

### 6.4 White-label y builder v1

| Capacidad | v1 | Fuera de v1 |
|-----------|----|-------------|
| White-label | Logo, colores, tipografía, dominio `cliente.producto.com` o propio vía Cloudflare, plantillas PDF/factura por tenant | Temas por usuario, email propio |
| Builder: campos | Campos custom por módulo/entidad con tipo, requerido y validación | Campos calculados y relaciones complejas |
| Builder: estados | Estados de pipeline, obra y episodio configurables con transiciones permitidas | Máquina de estados arbitraria |
| Builder: reglas | Reglas de permiso por estado y por alcance | Logic builder total |
| Builder: vistas | Vistas guardadas y compartidas por rol | Editor de layout drag-and-drop |

### 6.5 Accesibilidad y responsive

* WCAG 2.1 AA obligatorio en flujos críticos (login, agenda, asistencia, cobro, ficha).
* Contraste verificado, navegación por teclado, foco visible, etiquetas ARIA en formularios densos.
* Responsive desktop-first; tablet para obra y clínica (asistencia y bitácora usables a 768 px).
* PWA instalable desde MVP (sin offline funcional); encapsula la base para F2 Campo.

## 7. T6 — Fases, criterios de salida, riesgos y pendientes

### 7.1 Fases

| Fase | Duración | Entregables | Criterios de salida duros |
|------|----------|-------------|---------------------------|
| F0 Fundación | 3–4 semanas | Login MFA (Keycloak), tenants, org 3 niveles, RBAC + alcance + estado, auditoría append-only, RLS con linter en CI, archivos firmados, outbox + BullMQ, white-label base, Idempotency-Key, CI/CD en 2 entornos (shared y dedicado), OpenTelemetry | (1) Test de aislamiento entre dos tenants en CI pasa. (2) Migración sin `tenant_id` o sin policy rompe la build. (3) Baja de membership revoca acceso en <5 min medido. (4) Restore drill ejecutado y documentado. (5) 99.5% medible en horario laboral con probes |
| MVP1 Salud | 6–8 semanas en paralelo | Ficha Paciente 360, agenda, episodios, consentimientos, triaje, receta por plantilla, caja, factura electrónica de un país vía adaptador, 1 tablero por rol clave | (1) Flujo registro→consentimiento→cita→atención→cobro→factura completo con auditoría. (2) Caja no ve historia clínica (prueba de denegación). (3) Adaptador fiscal emite y reintenta en modo degradado. (4) Importador CSV de pacientes operativo. (5) Accesibilidad AA verificada en flujos críticos |
| MVP1 Obras | 6–8 semanas en paralelo | Ficha Obra 360, obras, cuadrillas, asignaciones, asistencia básica, equipos y horómetro manual, stock y consumos, presupuesto vs avance, bitácora con fotos | (1) Trabajador fuera de obra o de baja no marca asistencia ni accede. (2) Jefe ve solo sus obras (prueba de alcance). (3) Consumo de materiales descuenta stock en `posted`. (4) Importadores CSV de trabajadores y equipos operativos. (5) Tablero de obra con KPIs y caché |
| MVP2 | 6 semanas | WhatsApp/email/SMS plenos, API pública con API keys y webhooks, BI completa, builder de flujos, instancia dedicada en producción real, importadores ampliados, conector ERP/HCE elegido | (1) Tenant `isolated=true` corriendo en stack dedicado sin cambio de código. (2) Webhooks firmados con reintentos observables. (3) Builder permite campos y estados sin despliegue. (4) Facturación por uso conciliada con `usage_counters` |
| F2 Campo/IoT | post-MVP2 | PWA offline-first, sync por `sync_token`, ingesta MQTT/HTTP de telemetría, reglas de geocerca y mantenimiento por horas | Definido al cerrar MVP2 |

Compromiso de estimación: MVP1 dual = 4–6 meses con 6 personas enfocadas y sin agregar alcance.

### 7.2 Top 5 riesgos

| Riesgo | Impacto | Mitigación | Señal temprana |
|--------|---------|------------|----------------|
| Alcance triple (core full + integraciones + builder + BI) | Retraso sistémico | Fases con criterios de salida duros; MVP1 recorta WhatsApp/SMS, conector nativo y builder de flujos | Backlog de MVP1 crece sin cerrar F0 |
| Fuga entre tenants por RLS mal usado | Crítico legal y de confianza | Linter de migraciones + tests de aislamiento por tenant en CI + `FORCE ROW LEVEL SECURITY` | Alguna query sin `tenant_id` en índice |
| Fiscal del país subestimado | Bloqueo de facturación | Adaptador aislado + piloto con contador del país desde la semana 1 + modo degradado | Rechazos del ente sin causa mapeada |
| Builder total prematuro | Duplicación de producto | Limitar v1 a campos, estados, reglas y vistas guardadas | Pedidos de "campo calculado" y "flujo con ramas" |
| Low-cost sin disciplina operativa | Deuda operativa e incidentes | IaC + backups probados + restore drill mensual aunque el hosting sea Hetzner | Cambios manuales en servidores |

### 7.3 Pendientes que bloquean cierre (datos abiertos)

| # | Pendiente | Bloquea | Responsable de decisión |
|---|-----------|---------|-------------------------|
| 1 | País exacto (salud + fiscal + residencia de datos) | Validaciones fiscales, retención legal, esquema de factura | Usuario/negocio |
| 2 | Plantillas de consentimiento y de factura de los pilotos | Módulo salud y plantillas PDF | Usuario/negocio |
| 3 | Volúmenes reales (ver §7.5) | Dimensionamiento de BD, colas y storage | Usuario/negocio |
| 4 | Nombre comercial y dominios de white-label | Certificados, DNS, plantillas | Usuario/negocio |
| 5 | Conector ERP/HCE del primer cliente | Alcance de MVP2 | Usuario/negocio |
| 6 | Regla de retención exacta de salud por país | Purga programada y backups | Legal/normativa |
| 7 | Pasarela de pagos del país | Conciliación de `payments` | Usuario/negocio |

### 7.4 Plantillas requeridas (estructura mínima)

| Plantilla | Campos mínimos | Estado |
|-----------|----------------|--------|
| Consentimiento informado | Paciente, procedimiento, riesgos, versión de texto, firma/evidencia, fecha, retiro | Pendiente de contenido del piloto |
| Receta/orden | Paciente, profesional, fecha, ítems, indicaciones, vigencia | Pendiente de contenido del piloto |
| Factura electrónica | Emisor, receptor, ítems, impuestos, folio, estado fiscal, payload | Pendiente de país |
| PDF white-label | Logo, colores, datos del tenant, marca de agua en sensibles | Plantilla base en F0 |

### 7.5 Volúmenes de dimensionamiento (supuestos a validar)

| Métrica | Supuesto v1 | Implicación |
|---------|-------------|-------------|
| Tenants | 20–100 | Una topología shared + pocos dedicados |
| Usuarios | 2.000–10.000 | Idempotencia y caché de permisos corta |
| Concurrentes pico | ~1.000 | Pool PgBouncer, réplica, Redis |
| Citas por día (salud) | 500–3.000 | Índices por sede y fecha |
| Facturas por mes | 5.000–40.000 | Cola fiscal y conciliación por lotes |
| Fotos por bitácora/día | 200–2.000 | Storage y hash; nunca en BD |
| Eventos de telemetría (fase 2) | 10.000–500.000/día | No dimensionado en MVP1 |

## 8. T7 — Coherencia global y prohibiciones

### 8.1 Prohibiciones explícitas (no prometer)

| Prohibido | Motivo |
|-----------|--------|
| Hosting compartido tipo Hostinger para el core regulado | No ofrece RLS con pools dedicados, PITR real, réplica de lectura, red privada ni evidencia para auditoría con 1.000 concurrentes |
| Offline total o sincronización bidireccional en MVP | Solo se entrega la base (outbox, Idempotency-Key, `sync_token`); el offline es F2 Campo |
| Builder visual total en v1 | Se limita a campos, estados, reglas y vistas guardadas |
| Multi-país fiscal en v1 | Un país primero |
| Conector nativo ERP/HCE en MVP1 | API + webhooks + importadores CSV |
| Eliminación física de datos regulados | Borrado lógico + purga aprobada |
| Telemetría IoT productiva en MVP1 | Tablas mínimas creadas y vacías |

### 8.2 Trazabilidad de decisiones (sin contradicciones)

| Decisión (§1) | Resuelta en | Verificación |
|---------------|-------------|--------------|
| Salud + Construcción, fichas separadas | §2.3, §2.4, §6.1, §6.2 | Dos fichas, componentes compartidos |
| Híbrido shared + dedicado | §1.1, §4.2 | `tenant.isolated` sin cambio de código |
| 2k–10k usuarios, 1k concurrentes | §6.3, §7.5 | Caché, réplica, colas dimensionadas |
| Seguridad máxima regulada | §4.4, §4.5, §4.7 | Auditoría append-only, hash, retención |
| Core full + fiscal + inventario + asistencia básica | §2.2–§2.5, §2.6 | Exclusiones explícitas por fase |
| Postgres compartido + RLS | §4.1, §4.2 | Policy obligatoria y linter |
| RBAC + alcance + estado | §3.1–§3.5 | Matrices y casos de denegación |
| Módulos activables + white-label + builder limitado | §6.4 | Tabla v1 vs fuera de v1 |
| API-first con adaptadores | §5.1–§5.3 | Solo workers llaman adaptadores |
| Web ahora, offline/IoT después | §2.6, §5.1, §7.1 | Outbox + Idempotency-Key en F0 |
| Base + módulo + uso | §2.1, §4.6, §7.1 | `usage_counters` desde F0 |
| SLA 99.5% horario laboral | §7.1 (F0), §6.3 | Probes sintéticos y error budget |
| Stack TS + NestJS + Next.js + Postgres 16 + Redis + Keycloak + Hetzner + Cloudflare | §1.2 | Sin desviaciones |

### 8.3 Definición de "base construible"

El documento se considera sin falencias cuando: cada módulo tiene entidades, campos, estados y exclusiones; cada permiso se evalúa por la regla formal con casos de denegación probados; cada dato tiene `tenant_id`, policy, índice y retención; cada integración pasa por adaptador; cada fase tiene criterios de salida verificables; y ninguna promesa contradice §8.1.

**Datos abiertos que impiden cerrar el diseño del todo:** país, plantillas de consentimiento y factura, volúmenes reales, nombre y dominios, conector ERP/HCE, retención legal exacta y pasarela de pagos (ver §7.3).
