# Rizoma DB — fundación (F0/T2, T4)

Migraciones `migrations/001_core_foundation.sql` (tablas core + RLS por tenant)
y `migrations/002_onboarding.sql` (alta de primer arranque, ver más abajo).
Contrato (bases-consolidadas-v1.md §4.2): la app se conecta por PgBouncer
(`localhost:6432`, modo transaction) como rol `rizoma_app` (sin SUPERUSER —
los superusuarios burlan RLS incluso con `FORCE`) y abre cada transacción con:

```sql
BEGIN;
SET LOCAL app.tenant_id = '<uuid del tenant>';
-- ... trabajo ...
COMMIT;
```

Sin `app.tenant_id` no se ve ninguna fila de negocio. Las migraciones y
tareas admin usan la conexión directa (`localhost:5432`, superusuario).

## Comandos

```bash
npm run db:migrate            # aplica 001 sobre la DB local rizoma
npm run db:migrate:test       # crea rizoma_t2_test y aplica 001 (scratch)
npm run db:lint               # linter RLS: falla si falta tenant_id o policy
npm run db:test-isolation     # prueba de aislamiento con 2 tenants sintéticos
```

## Excepciones del linter

`tenants` (raíz del modelo) y `schema_migrations` (control interno) no llevan
`tenant_id`; están en la allowlist explícita de `lint/rls_lint.sh`.

## Onboarding de primer arranque (F0/T4)

Migración `migrations/002_onboarding.sql` (anexo Perú §11). Se aplica después
de 001 y es re-ejecutable:

```bash
psql postgresql://rizoma:rizoma_demo_password@localhost:5432/rizoma \
  -v ON_ERROR_STOP=1 -f db/migrations/002_onboarding.sql
```

**Disparo:** la base está vacía —cero tenants o `app_state` sin
`initialized_at`—; el wizard corre una sola vez y no se reabre con un tenant ya
inicializado. Mientras el acta no exista, toda ruta de negocio responde
`onboarding_pending`.

**Wizard (7 pasos, `apps/api/src/onboarding/service.ts`):**

| # | Paso | Dato capturado |
|---|------|----------------|
| 1 | Organizador | Razón social, RUC (dígito verificador SUNAT) y domicilio fiscal |
| 2 | Sedes IPRESS | Nombre, domicilio y correo ARCO por sede |
| 3 | Identidad | Nombre visible y responsable del tratamiento |
| 4 | Facturación | `manual` por defecto; `sunat_beta` exige entorno |
| 5 | Administrador | Usuario, correo y MFA activo |
| 6 | Revisión | Resumen sin datos nuevos |
| 7 | Acta de alta | Confirmación y acta inmutable |

**Tablas:**

- `app_state (key PK, value JSONB)` — singleton global del arranque.
- `onboarding_cases (id, idempotency_key UNIQUE, current_step, status, organizer,
  sites, identity, billing, admin_user, acta_hash, created_at, updated_at)` —
  estado reanudable del alta; `idempotency_key` evita duplicar el tenant.
- `onboarding_acta (id, tenant_id FK tenants, case_id, hash, payload,
  created_at)` — acta firmada: `hash` es el SHA-256 del JSON canónico del alta.
  Append-only (`REVOKE UPDATE, DELETE` + trigger).

**Excepciones RLS de 002 (entradas nuevas de la allowlist del linter):**

- `app_state` vive antes que cualquier tenant: es clave/valor global sin
  `tenant_id`, así que no puede tener RLS.
- `onboarding_cases` guarda datos pre-tenant: mientras el wizard recorre los 7
  pasos el tenant todavía no existe. Sin `tenant_id` ni RLS.
- Ambas quedan **accesibles solo al rol de setup**: 002 revoca los privilegios
  que 001 concedería por default a `rizoma_app`. El flujo de alta corre por la
  conexión admin directa (`localhost:5432`), igual que las migraciones.
- `onboarding_acta` **no** es una excepción: `tenant_id NOT NULL` + RLS
  `ENABLE`/`FORCE` + policy `tenant_isolation`, igual que las tablas de 001.
