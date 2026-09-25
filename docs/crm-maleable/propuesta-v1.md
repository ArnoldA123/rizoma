# CRM Maleable Multivertical — Propuesta v1

**Estado:** Propuesta de análisis (sin código).
**Alcance de esta sesión:** solo análisis y diseño de propuesta.
**Decisión base consolidada:** núcleo común + módulos activables por vertical/tenant. Pilotos: Salud + Construcción. Solo web en MVP, con base lista para campo offline e IoT.
**Equipo supuesto:** 6+ personas o externo. Escala 12 meses: 2k–10k usuarios, ~1k concurrentes. Modelo híbrido. Seguridad máxima regulada. SLA 99.5% horario laboral.
**Idioma del documento:** español neutro.

---

## 0. Decisiones tomadas en las rondas de análisis

| # | Dimensión | Decisión | Implicación directa |
|---|-----------|----------|---------------------|
| 1 | MVP | 2 verticales piloto a la vez | Obliga a validar maleabilidad real desde v1, duplica diseño de fichas |
| 2 | Entrega | Híbrida (shared + dedicada) | Dos topologías desde infra y despliegue, no una sola |
| 3 | Equipo | 6+ | Permite 2 streams paralelos + plataforma |
| 4 | Stack | Óptimo robusto para miles de usuarios, a recomendación | Se propone TS full-stack abajo |
| 5 | Verticales | Salud + Construcción | Contraste regulado + operativo, fichas separadas |
| 6 | Escala | 2k–10k usuarios, 1k concurrentes | Caché, colas, réplica lectura y RLS bien hechos desde v1 |
| 7 | Campo/Tel | Solo web en MVP | Se diseña API idempotente + event bus, no se construye offline/IoT aún |
| 8 | Seguridad | Máxima regulada | Auditoría inmutable, MFA, consentimientos, retención, residencia |
| 9 | Core | Full + facturación e inventario | MVP grande, exige fases (ver §18) |
| 10 | Integraciones | Todas a nivel diseño | API-first, adaptadores; no todas construidas en MVP1 |
| 11 | BD | Postgres compartido + RLS | Aislamiento lógico fuerte + opción dedicada para tenant crítico |
| 12 | UX | Módulos activables + white-label + constructor | Builder limitado a campos/flujos/permisos en MVP |
| 13 | Permisos | RBAC + alcance + estado (ej. clínica/obra) | Modelo §11, no RBAC simple |
| 14 | Ficha | Separadas (paciente vs obra) | Dos UIs de detalle, componentes compartidos |
| 15 | Cloud | Opción económica (estilo Cloudflare/Hostinger) | Se propone alternativa seria low-cost en §7 |
| 16 | Cobro | Base + módulo + uso | Billing medido desde v1 aunque sea simple |
| 17 | Org | Empresa > sede/sucursal > área/proyecto | Todo permiso y reporte filtra por ese árbol |
| 18 | Asistencia | Básica en MVP | Activo/baja bloquea acceso; turnos/geocerca fase 2 |
| 19 | Reportes | BI + tableros por rol | Operativos + KPIs desde v1 mínimo viable |
| 20 | Builder | Flujos y permisos, sin constructor total | Admin configura sin código hasta ese nivel |
| 21 | País | Un país primero | Facturación y salud atadas a una normativa |
| 22 | Fact. electrónica | Integrada en MVP | Requiere adaptador fiscal del país |
| 23 | Offline futuro | Sí, API idempotente + colas | Outbox + sync tokens desde fundación |
| 24 | SLA | 99.5% horario laboral | Backups, monitoreo y runbooks acordes, no 24/7 |

> Riesgo aceptado y marcado: 9+10+12+19 juntos equivalen a ~3 MVPs. Este documento los ordena en fases para que el MVP1 sí salga.

---

## 1. Visión y principios

**Visión:** un solo producto que se comporta como un CRM distinto según la vertical activada, sin forks de código por cliente.

**Principios:**

1. Core inmutable, verticales configurables.
2. Todo dato pertenece a un tenant y a un nodo org. Sin dato huérfano.
3. Ningún acceso sin alcance y estado válidos.
4. Nada se borra físicamente en dominios regulados; se anula con auditoría.
5. API idempotente y auditable antes que UI bonita.
6. Integraciones por adaptadores, nunca lógica fiscal/externa en el core.
7. Costo operativo bajo sin sacrificar aislamiento ni backups.

**No-objetivos v1:** app móvil nativa, offline total, telemetría IoT en producción, constructor visual total, multi-país fiscal, SSO/SCIM completo para todos los planes.

---

## 2. Arquitectura propuesta

### 2.1 Capas

```
[ Next.js Web por rol ] 
        |
[ API Gateway + Auth (OIDC/MFA) ]
        |
[ Core API NestJS: tenants, org, users, RBAC, auditoría, archivos, billing ]
        |
[ Módulos: crm | salud | obras | inventario | asistencia | facturación | reportes ]
        |
[ Outbox -> Queue (BullMQ) -> Workers -> Integraciones / Notificaciones / BI ]
        |
[ Postgres + RLS + réplica lectura ] [ Redis ] [ S3-compatible ]
```

### 2.2 Modelo híbrido concreto

* **Entorno Shared:** la mayoría de tenants en un mismo cluster Postgres con RLS + schemas lógicos por tenant. Despliegue único.
* **Entorno Dedicado:** para clínica/empresa regulada que lo exija: misma imagen, base y bucket propios, misma versión, bandera `tenant.isolated=true`. El código no cambia, cambia el binding de infraestructura.
* **Cloudflare delante de ambos:** DNS, CDN, WAF, Zero Trust para admin, Tunnel sin exponer puertos.

### 2.3 Multitenancy y aislamiento

* `tenant_id` obligatorio en toda tabla de negocio. RLS `USING (tenant_id = current_setting('app.tenant_id'))`.
* Conexiones con `SET app.tenant_id, app.user_id, app.scopes` por request. El pool usa `SET LOCAL` por transacción vía PgBouncer en modo transaction.
* Tenant crítico: `DATABASE_URL` distinta resuelta por `tenant_id`. El resto comparte pool.
* Archivos: prefijo `tenant/{id}/...`, URLs firmadas cortas, sin URLs públicas permanentes para salud.

---

## 3. Stack óptimo recomendado

| Capa | Elección v1 | Versión base | Por qué | Alternativa descartada y motivo |
|------|-------------|--------------|---------|---------------------------------|
| Lenguaje | TypeScript | 5.6+ / Node 22 LTS | Un solo lenguaje full-stack, tipado punta a punta, hiring amplio | Python: excelente en datos, pero dos lenguajes y menos ecosistema SaaS multi-tenant listo |
| Backend | NestJS + REST + validación Zod | Nest 11 | Estructura por módulos que mapea 1:1 a módulos de negocio, DI, guards para RBAC/scope | Fastify puro: más rápido pero sin estructura para equipo 6+ |
| Frontend | Next.js + React + Tailwind + shadcn/ui | Next 15, React 19 | SSR para listas pesadas, mismo design system para ambas fichas | SPA pura Vite: pierde SEO/reportes compartibles y SSR |
| ORM | Drizzle ORM + SQL directo para RLS | actual | Control fino de RLS, migraciones SQL revisables | Prisma: productivo pero fricción con RLS y policies |
| Auth | Keycloak self-hosted (OIDC) + MFA TOTP/WebAuthn | 25+ | SSO/SAML futuro, MFA, federación, sin costo por usuario | Auth0/WorkOS: excelente pero costo por MAU mata modelo base+uso |
| BD | Postgres 16 + PgBouncer + réplica | 16 | RLS maduro, JSONB para campos dinámicos, PITR | MySQL: RLS débil; Mongo: auditoría y joins regulatorios más caros |
| Caché/colas | Redis 7 + BullMQ | 7 | Sesión, rate-limit, trabajos, outbox relay | Kafka: sobredimensionado para 1k concurrentes |
| Archivos | S3-compatible (R2/MinIO) | — | Costo bajo, URLs firmadas | Disco local: rompe híbrido y backups |
| Tiempo real | WebSocket solo para notificaciones/kanban | — | No usar para dato crítico | SSE para reportes largos |
| Observabilidad | OpenTelemetry + Prometheus + Loki + Uptime | — | Traza request->query->worker exigible por SLA | Solo logs texto: no verifica 99.5% |
| IaC | Terraform + Ansible + GitHub Actions | — | Dos entornos reproducibles | ClickOps: impide híbrido serio |

**Estructura de repos:**

* `apps/web` (Next.js), `apps/api` (NestJS), `apps/workers`, `packages/ui`, `packages/config`, `packages/contracts` (Zod/DTO compartidos), `infra/terraform`, `docs/`.

---

## 4. Base de datos y modelo de datos

### 4.1 Tablas fundacionales (resumen real)

* `tenants(id, name, plan, isolated, country, locale, theme, modules[])`
* `org_nodes(id, tenant_id, parent_id, kind[empresa,sede,sucursal,area,proyecto,obra,especialidad], name, active)`
* `users(id, tenant_id, name, email, phone, active, mfa_enrolled)`
* `memberships(user_id, tenant_id, org_node_id, role, scopes, active, valid_from, valid_to)` — el corazón del permiso por sede/obra.
* `roles(code, tenant_id, vertical, permissions[])` + `role_bindings` para especialidad.
* `persons` / `companies` (contactos genéricos CRM).
* `deals` + `deal_stages` (pipeline configurable por vertical).
* `patient_files` (salud, separada), `episodes`, `appointments`, `consents`.
* `sites` (obras/proyectos), `crews`, `assignments(worker, site, active)`, `attendance(check_in/out, source)`.
* `assets` (maquinaria/equipos), `inventory_items`, `stock_moves`.
* `quotes`, `invoices`, `payments` (facturación con `fiscal_status`, `fiscal_adapter`, `fiscal_payload`).
* `documents` + `attachments` (bucket keys, hash sha256, retención).
* `audit_log(id, tenant_id, actor, action, entity, entity_id, org_node_id, diff, ip, at)` append-only.
* `outbox(id, aggregate, event, payload, occurred_at, dispatched_at)` para bus.
* `telemetry_events(device_id, ts, kind, payload)` y `devices` creadas mínimas desde fundación aunque vacías.
* `visits` + `checkins` mínimas para futuro offline.
* `usage_counters(tenant_id, metric, period, qty)` para cobro por uso.

### 4.2 RLS (patrón real)

```sql
ALTER TABLE patient_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON patient_files
USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- + policy porête: escritura solo si membership activo en org_node
```

Toda migración pasa linter: sin tabla de negocio sin `tenant_id`, sin policy, sin índice `(tenant_id, ...)`.

### 4.3 Analítica sin matar transaccional

* Réplica lectura Postgres para reportes/BI.
* ETL nocturno a esquema `mart_*` o a ClickHouse/DuckDB si el BI crece. MVP: vistas materializadas + caché Redis 5–15 min por tablero.
* `usage_counters` se escribe vía workers, nunca en request caliente.

### 4.4 Backups y retención

* PITR 7–30 días según plan, snapshot diario inmutable, restore drill mensual documentado.
* Retención legal por país: salud 5–10 años típico (definir con normativa del país elegido), fiscal según ente tributario. Borrado solo lógico + purga programada con aprobación.

---

## 5. Seguridad máxima regulada (checklist v1)

1. OIDC + MFA obligatorio para admin/salud/caja. Sesiones cortas + refresh rotation.
2. RBAC + alcance + estado en cada endpoint (guard central, no checks sueltos).
3. Cifrado en tránsito TLS 1.2+, en reposo AES-256, secretos en Vault/age, rotación.
4. `audit_log` append-only, sin UPDATE/DELETE por rol app, hash encadenado opcional para inmutabilidad demostrable.
5. Enmascaramiento: DNI, diagnóstico, montos según permiso. Listados nunca devuelven historia completa.
6. Rate-limit por tenant+IP, WAF Cloudflare, cabeceras seguras, CSRF, CSP.
7. Subida de archivos con antivirus + validación MIME + hash + retención.
8. Backups cifrados y prueba de restore. Bitácora de accesos a backup.
9. Gestión de baja: `users.active=false` o `membership.active=false` revoca en <5 min (sin caché larga de permisos).
10. Residencia: datos y backups en jurisdicción del país elegido. Cláusula contractual.
11. DLP mínimo: sin exportación masiva sin aprobación + marca de agua en PDFs sensibles.
12. Pentest ligero + dependencias con SCA (Dependabot/Renovate + `npm audit` en CI) y SBOM.

---

## 6. Infraestructura low-cost seria

### Por qué no Hostinger compartido para este caso

Hosting compartido no da: RLS con pools dedicados, PITR real, réplica lectura, red privada entre app/BD/Redis, WAF gestionable, ni evidencia para auditoría salud/fiscal con 1k concurrentes. Sirve para landing, no para el core regulado.

### Topología propuesta (económica pero profesional)

* **DNS/CDN/WAF:** Cloudflare (plan Free/Pro $0–20). R2 para archivos ($0.015/GB).
* **Compute:** Hetzner (ejemplo real): 2× CPX31 (4 vCPU/8GB, ~$18 c/u) para API, 1× CPX21 para workers, 1× CCX33 o Postgres gestionado para BD primaria. Total compute inicio ~$80–160/mes.
* **Redis:** VPS pequeño o Upstash/Redis Cloud inicio.
* **Entorno dedicado:** duplicar stack mínimo solo para ese tenant (1 app + 1 pg + bucket propio).
* **CI/CD:** GitHub Actions -> imágenes -> deploy blue/green por entorno. Migraciones con `expand/migrate/contract`.
* **Costo total orientativo inicio:** $150–350/mes shared + monitoreo. Escala 10k usuarios: $800–1.500/mes. Muy por debajo de AWS puro y con control total.

### Cómo se cumple el 99.5% horario laboral

* SLO: 99.5% mensual en horario 07:00–20:00 país. Error budget visible.
* Probes sintéticos cada 1 min a login, agenda y facturación. Alertas a canal on-call.
* Runbooks: caída BD, cola saturada, R2 caído, fiscal caído (modo degradado: emite interno + reintenta).
* Ventana de mantenimiento anunciada, backups antes de cada release con migraciones.

---

## 7. Sistema de módulos

| Módulo | Código | Activa en | Depende de | Billing |
|--------|--------|-----------|------------|---------|
| Core CRM | `crm-core` | siempre | — | base |
| Salud | `salud` | tenant salud | crm-core, docs, billing | +módulo |
| Obras | `obras` | tenant construcción | crm-core, inventario, asistencia | +módulo |
| Inventario/Activos | `inventario` | ambos si usa | crm-core | +módulo |
| Asistencia | `asistencia` | ambos | core, org | +uso (checks) |
| Facturación | `facturacion` | ambos | core, adaptador fiscal | +uso (folios) |
| Reportes/BI | `reportes` | ambos | todos | base/+uso |
| Builder | `builder` | admin | core | plan alto |

Activación por `tenant.modules[]` + feature flags por entorno. Sin forks: mismo binario, distinta configuración.

---

## 8. Vertical Salud (ficha separada)

**Entidades:** paciente, episodio, cita, triaje mínimo, consentimiento, adjuntos, receta/orden (plantilla, no HCE completa en MVP), cuenta/caja, factura.

**Flujos MVP:**
1. Registro -> verificación -> consentimiento firmado -> cita -> atención -> cobro -> factura electrónica -> auditoría.
2. Caja no ve historia clínica; médico no ve montos salvo permiso; recepción no edita diagnóstico.

**Campos mínimos paciente:** identidad, contacto, sede, especialidad, alergias/alertas, consentimientos vigentes, episodios abiertos. Historia detallada paginada y auditada por acceso.

---

## 9. Vertical Construcción y maquinaria (ficha separada)

**Entidades:** obra/proyecto, sucursal, cuadrilla, trabajador, asignación obra, asistencia, equipo/maquinaria, horómetro, stock, presupuesto/avance, hito, bitácora con fotos.

**Flujos MVP:**
1. Obra -> sucursal -> cuadrilla -> asignación (activo) -> asistencia diaria -> avance/bitácora -> consumo materiales -> presupuesto vs real.
2. Trabajador fuera de obra o de baja no accede ni marca en esa obra. Jefe solo sus obras. Gerente multi-obra con scope explícito.
3. Maquinaria: ficha activo + asignación + horómetro manual en MVP (sensor/IoT en fase 2 vía `telemetry_events`).

---

## 10. Permisos: modelo RBAC + alcance + estado

Regla formal:

> `allow = role.permite(acción) AND membership.activo AND org_node en scope AND estado_entidad permite AND tenant.módulo activo`

**Roles base propuestos:**

* Salud: `ti_admin, direccion, medico, enfermeria, recepcion, caja, auditor`.
* Construcción: `gerente, jefe_obra, almacen, capataz, trabajador, auditor`.
* Transversal: `vendedor, soporte`.

**Matriz ejemplo (extracto):**

| Acción | Recepción | Caja | Médico | Jefe obra | Trabajador |
|--------|-----------|------|--------|-----------|------------|
| Ver agenda sede | sí (sede) | no | sí (propia) | n/a | no |
| Ver historia | no | no | sí (sus pacientes) | n/a | n/a |
| Cobrar/emitir factura | no | sí | no | no | no |
| Ver obra | n/a | n/a | n/a | sí (sus obras) | sí (asignado+activo) |
| Marcar asistencia | sí | sí | sí | aprobar | solo propia |
| Exportar masivo | no | no | no | no | no |

La baja (`active=false` o fin de asignación) corta acceso aunque el rol siga existiendo. Todo denegado registra en auditoría.

---

## 11. UX/UI, vistas y personalización

* **Design system único:** tokens, tablas densas con filtros guardados, kanban pipeline, calendario agenda, fichas con timeline.
* **Fichas separadas:** `Paciente 360` vs `Obra 360`, mismos componentes (timeline, archivos, tareas, cobros) con bloques distintos.
* **Tableros por rol v1:** recepción (citas/colas), caja (cobros/facturas), médico (mis pacientes/citas), jefe obra (avance/asistencia/stock), gerencia (embudo, cobranza, avance global).
* **White-label:** logo, colores, dominio `cliente.producto.com` o propio vía Cloudflare, plantillas PDF/factura por tenant.
* **Builder v1 (limitado a propósito):** campos custom por módulo, estados de pipeline/obra/episodio, reglas de permiso por estado, vistas guardadas. Sin logic builder total hasta fase 2.

Accesibilidad WCAG AA en flujos críticos, responsive desktop-first + tablet para obra/clínica, PWA instalable desde MVP aunque sin offline total.

---

## 12. Integraciones e interfaces

* **Comunicación:** adaptador único `notify.send(to, channel, template)`. WhatsApp Business API (plantillas aprobadas), email transaccional, SMS fallback. Todo evento deja `message_log` + costo para billing por uso.
* **Facturación electrónica (un país):** patrón adaptador `FiscalAdapter.emit(invoice)->folio/status`. Cola con reintentos, modo degradado interno si el ente cae. Payload fiscal crudo guardado para auditoría. País pendiente de nombrar para atar esquema y validaciones.
* **Pagos:** pasarela del país (tarjeta/transferencia/QR). Conciliación `payments <-> invoices`.
* **ERP/HCE externa:** no se construye conector nativo en MVP1; se expone API + webhooks + importadores CSV. Un conector real se elige en MVP2 según cliente piloto.
* **API pública:** REST versionado `/v1`, OpenAPI, API keys por tenant con scopes, webhooks firmados HMAC, rate-limit por plan, idempotencia con `Idempotency-Key` en POST críticos.

---

## 13. Visitas y telemetría (roadmap, no MVP)

Aunque el MVP es web, la fundación ya deja:

* Tablas `visits, checkins, devices, telemetry_events` mínimas.
* Outbox + workers + `Idempotency-Key` + `sync_token` por tabla sincronizable.
* Fase 2 campo: PWA offline-first (visita, check-in/out GPS, fotos offline, firma), cola local IndexedDB -> sync.
* Fase 2 IoT: ingesta HTTP/MQTT para GPS/horómetros, reglas (fuera de geocerca, mantenimiento por horas), alertas al expediente obra/equipo. Billing por evento.

---

## 14. Reportes, uso y vistas de negocio

* Operativos exportables: citas, cobros, facturas, asistencia, stock, avance.
* Tableros rol (ver §11) con caché corta y réplica lectura.
* Eventos de uso medidos: usuarios activos, mensajes, folios fiscales, storage, eventos IoT futuros. Alimentan `usage_counters` y el cobro base+módulo+uso.

---

## 15. Modelo comercial sugerido

* Base por tenant (incluye core + usuarios base + storage base).
* + por módulo activado (`salud`, `obras`, `inventario`, `reportes pro`).
* + por uso (mensajes, folios, storage extra, eventos).
* Instancia dedicada con recargo fijo. SSO/SAML solo plan empresarial.

---

## 16. Operación y observabilidad

* Logs JSON con `tenant_id, user_id, trace_id`. Trazas API->DB->worker.
* Dashboards: latencia p95, errores 5xx por módulo, saturación colas, RLS misses, fiscal error rate, backup age.
* Backups probados, restore drill mensual, postmortem sin culpa.
* Soporte horario laboral con canal y tiempos: P1 <4h, P2 <1 día hábil.

---

## 17. Roadmap por fases (equipo 6+)

**F0 Fundación (3–4 sem). Salida:** login MFA, tenants, org 3 niveles, RBAC+scope+estado, auditoría, RLS, archivos firmados, outbox+colas, white-label base, CI/CD 2 entornos.
**MVP1 Salud (6–8 sem en paralelo). Salida:** ficha paciente, agenda, consentimientos, caja + fiscal un país, 1 tablero.
**MVP1 Obras (6–8 sem en paralelo). Salida:** ficha obra, personal por obra, asistencia básica, equipos/stock, presupuestos vs avance.
**MVP2 (6 sem). Salida:** WhatsApp/email/SMS plenos, API/webhooks, BI completa, builder flujos, instancia dedicada, importadores.
**F2 Campo/IoT (después).** PWA offline + ingesta telemetría.

Estimación honesta MVP1 dual: 4–6 meses con 6 personas enfocadas, si no se agrega alcance.

---

## 18. Riesgos y supuestos

1. Alcance full + todo integrado es el mayor riesgo. Mitigación: fases con criterios de salida duros.
2. RLS mal usado = fuga entre tenants. Mitigación: linter migraciones + tests de aislamiento por tenant en CI.
3. Fiscal por país subestimado. Mitigación: adaptador + piloto con contador del país desde semana 1.
4. Builder total prematuro. Mitigación: limitar a campos/flujos/permisos.
5. Low-cost sin disciplina = deuda operativa. Mitigación: IaC + backups probados aunque sea Hetzner.

---

## 19. Qué falta para profundizar (próxima ronda)

1. País exacto para salud + fiscal y residencia.
2. Plantillas de consentimiento y factura que ya usan los pilotos.
3. Volúmenes reales: citas/día, facturas/mes, fotos por bitácora, equipos a rastrear.
4. Nombre comercial y dominios para white-label.
5. Decidir conector ERP/HCE del primer cliente.

---

## Anexos

### A. Glosario mínimo
Tenant, Org node, Membership, Scope, RLS, Outbox, Idempotencia, White-label, Folio fiscal.

### B. ADRs iniciales
* ADR-001: TypeScript/NestJS + Next.js para velocidad y hiring SaaS.
* ADR-002: Postgres + RLS como aislamiento lógico, dedicado solo si exige regulación.
* ADR-003: Keycloak self-hosted para no pagar por MAU.
* ADR-004: Hetzner + Cloudflare como low-cost serio, no shared.
* ADR-005: Fichas separadas por vertical, componentes compartidos.
* ADR-006: Fiscal por adaptador, nunca en core.

### C. Convención API
`POST /v1/{modulo}/{recurso}` con `Idempotency-Key`, `GET` con `?tenant_scope=...` implícito por token, errores `{code, message, traceId}`. Webhooks `X-Signature: hmac-sha256`.

---

*Fin propuesta v1. Siguiente paso sugerido: fijar país + plantillas piloto y abrir diseño de datos detallado por vertical.*
