# Rizoma — gestión para consultorios y obras

Rizoma es un sistema para llevar el día a día de un **consultorio o clínica**
y de una **obra de construcción**, cada uno con su espacio separado y seguro.

## Qué puede hacer usted aquí

### Si trabaja en salud

- **Médico:** ve sus citas del día, abre la ficha de cada paciente (signos,
  episodios, recetas, consentimientos, citas y cuenta), emite recetas y deriva
  el cobro a recepción.
- **Recepción:** registra pacientes, agenda y confirma citas, reprograma o
  anula en dos clics, crea consentimientos para que el médico los firme.
- **Caja:** abre y cierra su turno, emite comprobantes, cobra y anula con
  motivo.

### Si trabaja en obras

- **Jefe o capataz:** ve su obra (personal, asistencia, equipos, stock,
  avance contra presupuesto y bitácora), registra avances y aprueba asistencia.
- **Obrero:** marca su asistencia con un botón desde el celular.
- **Auditoría:** revisa movimientos de stock, bitácora y comprobantes.

### En ambos casos

- Cada persona entra con su usuario y ve solo lo de su rol y su sede.
- Todo error se explica en lenguaje simple: qué pasó, qué hacer y a quién
  avisar.
- Los datos de demostración son ficticios.

## Cómo entrar (demostración local)

1. Levante el sistema con la [guía de instalación](#instalación-para-desarrollo).
2. Abra `http://localhost:3000`.
3. Entre con un usuario de demostración (ej. `medico.demo`) y su código de
   seguridad.

## Estado del proyecto

Versión `0.2.0`, en desarrollo activo. Lo incluido: fichas 360 de paciente y
obra, agenda y caja, personal y asistencia, equipos/stock/avance/bitácora,
importación por CSV, tableros por rol, API pública con webhooks y
notificaciones. Detalle de cambios en `CHANGELOG.md`.

---

## Instalación para desarrollo

### Requisitos

- Node 22 (ver `.nvmrc`): `nvm use`
- Docker Engine 29+ con Compose v2.30+

### Pasos

```bash
nvm use                       # Node 22
npm install                   # workspaces: apps/*, packages/*

cp .env.example .env          # variables de aplicación
cp infra/docker/.env.example infra/docker/.env   # variables de infraestructura

npm run compose:config        # valida la infraestructura local
npm run compose:up            # postgres, pgbouncer, redis, keycloak, s3
docker ps                     # verificar contenedores y healthchecks

npm run typecheck             # verificación de tipos
npm test                      # suites unitarias
```

Para detener: `npm run compose:down`.

### Servicios locales

| Servicio | Puerto | Notas |
|----------|--------|-------|
| Postgres 16 | `5432` | base demo `rizoma`, volumen `pgdata` |
| PgBouncer | `6432` | pooling `transaction` |
| Redis 7 | `6379` | colas BullMQ |
| Keycloak 26 | `8080` | consola admin |
| S3 local | `4566` | storage S3-compatible (LocalStack) |
| Web | `3000` | interfaz Next.js |

Los valores de `.env.example` son **sintéticos, solo desarrollo local**.
Los secretos reales viven en la bóveda de secretos.

## Cómo está construido

| Capa | Elección |
|------|----------|
| Lenguaje | TypeScript 5.6+ / Node 22 LTS |
| Backend | NestJS 11 + REST + Zod |
| Frontend | Next.js 15 + React 19 + Tailwind + shadcn/ui |
| Datos | Postgres 16 + PgBouncer + Drizzle |
| Colas | Redis 7 + BullMQ |
| Auth | Keycloak 25+ (OIDC + MFA TOTP/WebAuthn) |
| Archivos | S3-compatible (LocalStack en local, R2 en prod) |
| Observabilidad | OpenTelemetry + Prometheus + Loki + Uptime |

Aislamiento por tenant (`tenant_id` + RLS) sobre Postgres 16.

## Mapa del monorepo

```text
rizoma/
├── apps/
│   ├── api/          # NestJS 11 (REST + RLS + RBAC)
│   ├── web/          # Next.js 15 (interfaz por rol)
│   └── workers/      # BullMQ (entregas, notificaciones)
├── packages/
│   └── contracts/    # contratos compartidos (Zod)
├── infra/
│   └── docker/       # compose.yml + .env.example locales
├── db/
│   ├── migrations/   # esquema versionado
│   └── seeds/        # datos demo sintéticos
├── docs/
│   ├── api-publica/  # guía de API pública y webhooks
│   └── ci-e2e.md     # CI y pruebas de navegador
├── odd/
│   └── tasks/        # plan de trabajo por propuesta
└── .github/
    └── workflows/    # CI (5 verificaciones)
```

## CI

`.github/workflows/ci.yml` (5 verificaciones en cada PR):

- `Compose config`, `Monorepo skeleton`, `RLS migration lint`,
  `Two-tenant isolation test`, `E2E (salud + obras)`.

`main` exige PR con CI verde para mergear.

## Convenciones

- Código, identificadores y tablas en inglés; documentación en español neutro.
- Datos demo sintéticos (documentos y correos ficticios).
- Commits unidad de trabajo (Conventional Commits) en ramas `feat/...`,
  con tests y docs junto al cambio.
