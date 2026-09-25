# Rizoma — CRM maleable multivertical (Perú)

Monorepo de la fundación (F0) del CRM maleable: Core CRM + verticales Salud y
Construcción, con aislamiento por tenant (`tenant_id` + RLS) sobre Postgres 16.

> Estado: **esqueleto F0**. Sin lógica de negocio todavía. Este documento
> describe cómo levantarlo y dónde vive cada cosa.

## Stack

| Capa | Elección |
|------|----------|
| Lenguaje | TypeScript 5.6+ / Node 22 LTS |
| Backend | NestJS 11 + REST + Zod |
| Frontend | Next.js 15 + React 19 + Tailwind + shadcn/ui |
| Datos | Postgres 16 + PgBouncer (transaction) + Drizzle |
| Colas | Redis 7 + BullMQ |
| Auth | Keycloak 25+ (OIDC + MFA TOTP/WebAuthn) |
| Archivos | S3-compatible (LocalStack S3 en local, R2 en prod) |
| Observabilidad | OpenTelemetry + Prometheus + Loki + Uptime |

Fuente de verdad del diseño: `docs/crm-maleable/bases-consolidadas-v1.md`.

## Requisitos

- Node 22 (ver `.nvmrc`): `nvm use`
- Docker Engine 29+ con Compose v2.30+ (probado con Docker 29.8.1 / Compose v5.5.1 en WSL)

## Quickstart

```bash
nvm use                       # Node 22
npm install                   # workspaces: apps/*, packages/*

cp .env.example .env          # variables de aplicación
cp infra/docker/.env.example infra/docker/.env   # variables de infraestructura

# Validar y levantar la infraestructura local
npm run compose:config
npm run compose:up            # postgres, pgbouncer, redis, keycloak, s3
docker ps                     # verificar contenedores y healthchecks

npm run typecheck             # placeholder hasta que exista código
```

Para detener el stack: `npm run compose:down`.

### Servicios locales

| Servicio | Host (loopback) | Notas |
|----------|-----------------|-------|
| Postgres 16 | `5432` | usuario/DB demo `rizoma`, volumen `pgdata` |
| PgBouncer | `6432` | pooling `transaction` hacia Postgres |
| Redis 7 | `6379` | BullMQ |
| Keycloak 26 | `8080` | consola admin; DB `keycloak` creada por `keycloak-db-init` |
| S3 | `4566` endpoint | storage S3-compatible local (LocalStack) |

Los valores de `.env.example` son **sintéticos, solo para desarrollo local**.
Nunca se reutilizan en entornos compartidos ni en producción; los secretos
reales viven en la bóveda de secretos.

## Mapa del monorepo

```text
rizoma/
├── apps/
│   ├── api/          # NestJS 11 (REST + RLS + RBAC)      — esqueleto
│   ├── web/          # Next.js 15 (UI + white-label)      — esqueleto
│   └── workers/      # BullMQ (outbox → colas, fiscal)    — esqueleto
├── packages/
│   └── contracts/    # contratos compartidos API/dominio  — esqueleto
├── infra/
│   └── docker/       # compose.yml + .env.example locales
├── db/
│   └── seeds/        # datos demo sintéticos (Perú)
├── docs/
│   └── crm-maleable/ # diseño construible (no modificar)
├── odd/
│   └── tasks/        # plan de fases F0..F6
└── .github/
    └── workflows/    # CI base
```

Estructura de repos objetivo (bases §1.2): `apps/web`, `apps/api`,
`apps/workers`, `packages/*`, `infra/terraform`, `docs/`.

## CI

`.github/workflows/ci.yml` corre dos jobs sin secretos:

- `compose-config`: valida `infra/docker/compose.yml` con `docker compose config`.
- `skeleton`: instala los workspaces y ejecuta los scripts placeholder.

## Convenciones

- Identificadores, código y nombres de tabla en inglés; documentación en español neutro.
- Datos demo sintéticos (RUC `20123456789`, razón social y correos ficticios).
- SUNAT en beta desde F0 con adaptador `sunat_v1` y ruta `manual_v1` por defecto.

## Commits

**No se commitea sin orden explícita del usuario.** Cuando se autorice, se usa
una rama `feature/...` y commits unidad de trabajo (Conventional Commits),
con tests y docs junto al cambio de comportamiento.
