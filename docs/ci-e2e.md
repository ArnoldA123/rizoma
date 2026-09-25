# CI y E2E

Descripción breve de qué corre cada job de CI (`.github/workflows/ci.yml`)
y cómo reproducirlo en local. Playwright sigue fuera del repositorio por
decisión: la verificación con clics se hace con `playwright-cli` externo.

## Jobs

| Job | Qué hace | Cómo reproducirlo en local |
| --- | --- | --- |
| Compose config | Valida `infra/docker/compose.yml` sin levantar nada. | `npm run compose:config` |
| Monorepo skeleton | Instala los workspaces y corre el typecheck. | `npm install` + `npm run typecheck` |
| RLS migration lint | Revisa que las migraciones incluyan `tenant_id` y políticas. | `npm run db:lint` |
| Two-tenant isolation test | Levanta `postgres:16`, aplica `001` y corre `db/tests/tenant_isolation.sql`. | `npm run db:migrate:test` + `npm run db:test-isolation` (con Postgres local) |
| E2E (salud + obras) | Levanta `postgres:16` + `redis:7`, aplica las migraciones 001–009 y corre `test:e2e` y `test:e2e-obras`. | Ver «E2E en local» abajo. |

## Job E2E en detalle

1. Servicios: `postgres:16` (usuario `rizoma`, clave demo, base `rizoma`,
   los mismos valores que el harness usa por defecto) y `redis:7` sin clave.
2. `npm ci`, luego migraciones 001–009 con `psql` (`ON_ERROR_STOP=1`).
3. `npm run test:e2e --workspace @rizoma/api` (suite salud) y
   `npm run test:e2e-obras --workspace @rizoma/api` (suite obras).
   Cada script compila `dist` primero y luego levanta `dist/main.js`
   en un puerto libre de loopback con seeds idempotentes.
4. El job falla en rojo si alguna suite falla. Sin base de datos las suites
   hacen skip en local, pero en CI se exporta `REQUIRE_E2E_DB=1`, que
   convierte ese skip en error: un verde siempre significa que las suites
   corrieron de verdad.

Diferencias con el stack local de `infra/docker`: el job no levanta
PgBouncer (`DATABASE_URL_PGBOUNCER` apunta al mismo Postgres directo; el
contrato de `SET LOCAL` en una transacción funciona igual y PgBouncer
sigue siendo un tema de escala local/productivo) y Redis va sin clave
(`REDIS_URL=redis://localhost:6379`; la API arranca sin Redis y el caché
de tableros es fail-open, solo cambian los flags de `/health`).

## E2E en local

```bash
# 1. Stack local (Postgres 5432, PgBouncer 6432, Redis 6379).
cp infra/docker/.env.example infra/docker/.env  # solo la primera vez
docker compose -f infra/docker/compose.yml --env-file infra/docker/.env up -d

# 2. Dependencias y migraciones 001–009.
npm install
npm run db:migrate

# 3. Suites (usan la ruta de headers locales x-tenant-id/x-user-id, sin Keycloak).
cd apps/api
npm run test:e2e
npm run test:e2e-obras
```

Para reproducir la estrictitud de CI (fallar en vez de skip sin DB):

```bash
REQUIRE_E2E_DB=1 npm run test:e2e
REQUIRE_E2E_DB=1 npm run test:e2e-obras
```

Notas:

- Sin base de datos las suites hacen skip y `npm test` sigue hermético.
- Las fixtures son sintéticas con UUID fijos e inserciones idempotentes;
  re-correr no duplica estado ni requiere limpieza destructiva.
- Las dos suites usan tenants distintos y no comparten estado.
