// API root module. A1 registers the environment configuration and the health
// probe; A2 adds the per-request tenant context (SET LOCAL over PgBouncer) and
// the shared Postgres/Redis clients its probes use. A3 wires identity and
// authorization: the JWT verifier is built once from the runtime config and
// handed to the tenant middleware, and `auth/access.guard.ts` exposes
// `canActivate`/`loadMembership` for the endpoint layer that will call it.
// A4 (MVP1 Salud S2) mounts the clinical endpoints: the three `salud/*`
// controllers are thin and decorator-only — the guard, scope, state machine and
// write audit live in the plain `salud/salud.service.ts`, which imports no Nest
// decorators so it stays loadable under strip-only TypeScript.
// A5 (MVP1 Salud S3) adds `salud/consents.controller.ts` for the Peru
// teleinterconsultation consent; its plain service (`consents.service.ts`)
// follows the same split.
// A6 (MVP1 Salud S4) adds `billing/billing.controller.ts` for the cashier and
// manual invoicing flow; `billing/billing.service.ts` stays plain and owns the
// `invoice.issue` guard, the gapless folio and the `Idempotency-Key` gate.
// A7 (MVP1 Salud S5) adds the CSV patient importer and the per-role dashboards:
// `salud/import.controller.ts` + `salud/import.service.ts` (per-row validation,
// hash idempotency, `import_jobs` contract) and `salud/dashboards.controller.ts`
// + `salud/dashboards.service.ts` (§6.3 KPIs). Both services stay plain and own
// their guard, scope and SQL.
// A8 (MVP1 Obras O2) mounts the construction endpoints: `obras/sites.controller.ts`
// (site file), `obras/staff.controller.ts` (assignments) and
// `obras/attendance.controller.ts`. Their plain `obras/obras.service.ts` follows
// the same split and adds the construction access key — an active assignment —
// on top of the central guard.
// A9 (MVP1 Obras O3) mounts the resources endpoints: `obras/assets.controller.ts`
// (equipment and readings), `obras/stock.controller.ts` (items and moves),
// `obras/progress.controller.ts` (budget lines, progress, milestones) and
// `obras/site_logs.controller.ts` (site log). Their plain
// `obras/resources.service.ts` reuses the same split and the O2 access key.
// A10 (MVP1 Obras O4) adds the CSV importers and the boards:
// `obras/import.controller.ts` + `obras/import.service.ts` (workers and
// equipment CSV, per-row savepoints, hash idempotency, `import_jobs` contract)
// and `obras/dashboards.controller.ts` + `obras/dashboards.service.ts` (site
// board and company board, §6.2). Both services stay plain and own their guard,
// scope and SQL.
// A11 (MVP1 Salud H1) mounts the triage and prescription endpoints:
// `salud/triages.controller.ts` (insert-only vital signs, `patient.write`) and
// `salud/prescriptions.controller.ts` (template orders, `episode.write`). Their
// plain `salud/triages.service.ts` and `salud/prescriptions.service.ts` follow
// the same split: scope through the patient sede, one audit row per write.
// A12 (H3) mounts the first-run onboarding endpoint: `onboarding.controller.ts`
// is thin and decorator-only — the setup persistence (cases table, app_state
// gate, acta payload) lives in the plain `onboarding/store.ts`, which imports
// no Nest decorators so it stays loadable under strip-only TypeScript.
// The routes run before any tenant exists (migration 002, pre-tenant setup
// role), so they are excluded from the tenant middleware below.
// A13 (H2) mounts the signed file endpoints: `files.controller.ts` is thin
// and decorator-only — the plain `files/files.service.ts` owns validation,
// the guard, the canonical key (`files/paths.ts`), the manual SigV4 presigner
// (`files/s3.ts`, no AWS SDK) and the write audit, following the same split.
// A14 (W1) mounts the API key management endpoints: `auth/api-keys.controller.ts`
// is thin and decorator-only — the plain `auth/api-keys.ts` owns validation,
// the tenant-admin gate, the digest-only secret handling and the write audit,
// following the same split. Verification itself lives in the `X-Api-Key`
// branch of `TenantContextMiddleware`, before Bearer.
// A15 (MVP2 W2) mounts the webhook endpoints: `webhooks/webhooks.controller.ts`
// is thin and decorator-only — the plain `webhooks/webhooks.ts` owns
// validation, the tenant-admin gate, the digest-only signing secrets, the
// read-only delivery observability and the outbox writer
// (`enqueueInvoiceWebhooks`, called inside the emitter transaction). Delivery
// itself belongs to the workers (`webhook-deliver.ts`), so the API never
// moves a delivery row.
//
// Only the JWT verifier needs a provider: the guard is a pure function over
// facts the endpoint owns (identity, membership, entity, module), so there is
// nothing to inject into it yet.
//
// The configuration provider is a factory over a plain env record rather than
// a Nest config abstraction, so `src/config/configuration.ts` stays pure and
// the validation failure happens during module initialization (fail fast).
//
// Middleware wiring note: `TenantContextMiddleware` is deliberately decorator
// free, because `npm test` loads the sources through Node's strip-only type
// stripping, which cannot parse decorators and would make the tenant contract
// untestable. The pool and the verifier therefore reach it through the module
// instead of `@Inject`, and it is applied to the versioned API surface only
// (`/v1/*`): `/health`, the pre-tenant `/onboarding` setup routes, and future
// operational paths stay outside the tenant
// transaction.
import {
  Inject,
  Module,
  RequestMethod,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { ApiKeysController } from './auth/api-keys.controller.ts';
import { WebhooksController } from './webhooks/webhooks.controller.ts';
import {
  AUTH_JWT_VERIFIER,
  createKeycloakVerifier,
  type JwtVerifier,
} from './auth/jwt.ts';
import { CONFIG_TOKEN, load, type ApiConfig } from './config/configuration.ts';
import { HealthController, REDIS_CLIENT, createRedisClient } from './health/health.controller.ts';
import { BillingController } from './billing/billing.controller.ts';
import { FilesController } from './files/files.controller.ts';
import { OnboardingController } from './onboarding/onboarding.controller.ts';
import { AppointmentsController } from './salud/appointments.controller.ts';
import { ConsentsController } from './salud/consents.controller.ts';
import { DashboardsController } from './salud/dashboards.controller.ts';
import { EpisodesController } from './salud/episodes.controller.ts';
import { ImportsController } from './salud/import.controller.ts';
import { PatientsController } from './salud/patients.controller.ts';
import { PrescriptionsController } from './salud/prescriptions.controller.ts';
import { TriagesController } from './salud/triages.controller.ts';
import { AttendanceController } from './obras/attendance.controller.ts';
import { AssetsController } from './obras/assets.controller.ts';
import { ObrasDashboardsController } from './obras/dashboards.controller.ts';
import { ObrasImportsController } from './obras/import.controller.ts';
import { ProgressController } from './obras/progress.controller.ts';
import { SiteLogsController } from './obras/site_logs.controller.ts';
import { SitesController } from './obras/sites.controller.ts';
import { StaffController } from './obras/staff.controller.ts';
import { StockController } from './obras/stock.controller.ts';
import {
  PG_POOL,
  createTenantPool,
  TenantContextMiddleware,
  type TenantResponse,
  type TenantScopedRequest,
  type TenantPool,
} from './tenant/tenant.middleware.ts';

@Module({
  controllers: [
    HealthController,
    OnboardingController,
    PatientsController,
    EpisodesController,
    AppointmentsController,
    ConsentsController,
    TriagesController,
    PrescriptionsController,
    BillingController,
    FilesController,
    ApiKeysController,
    WebhooksController,
    ImportsController,
    DashboardsController,
    SitesController,
    StaffController,
    AttendanceController,
    AssetsController,
    StockController,
    ProgressController,
    SiteLogsController,
    ObrasImportsController,
    ObrasDashboardsController,
  ],
  providers: [
    {
      provide: CONFIG_TOKEN,
      useFactory: (): ApiConfig => load(process.env),
    },
    {
      // Single request-time pool for the whole process, pointed at PgBouncer in
      // transaction mode (§4.2). The health probe queries this same pool, so it
      // also covers the pooling layer the request path depends on.
      provide: PG_POOL,
      useFactory: (config: ApiConfig) => createTenantPool(config),
      inject: [CONFIG_TOKEN],
    },
    {
      provide: REDIS_CLIENT,
      useFactory: (config: ApiConfig) => createRedisClient(config.redisUrl),
      inject: [CONFIG_TOKEN],
    },
    {
      // The realm JWKS URL and issuer are derived from the config once, so no
      // request path reads the environment and the 10-minute key-set cache is
      // shared by every request of the process (see `auth/jwt.ts`).
      provide: AUTH_JWT_VERIFIER,
      useFactory: (config: ApiConfig): JwtVerifier => createKeycloakVerifier(config),
      inject: [CONFIG_TOKEN],
    },
  ],
})
export class AppModule implements NestModule {
  private readonly tenantPool: TenantPool;
  private readonly jwtVerifier: JwtVerifier;

  constructor(
    @Inject(PG_POOL) tenantPool: TenantPool,
    @Inject(AUTH_JWT_VERIFIER) jwtVerifier: JwtVerifier,
  ) {
    this.tenantPool = tenantPool;
    this.jwtVerifier = jwtVerifier;
  }

  configure(consumer: MiddlewareConsumer): void {
    const tenant = new TenantContextMiddleware(this.tenantPool, { verify: this.jwtVerifier });
    consumer
      .apply((req: TenantScopedRequest, res: TenantResponse, next: (error?: unknown) => void) => {
        void tenant.use(req, res, next);
      })
      // Nest resolves middleware paths *relative to the global prefix* and,
      // for a wildcard, also covers the routes the prefix excludes. `/health`
      // is therefore explicitly excluded: readiness must stay untransactional
      // and must not depend on a tenant header. `{*path}` is the Express 5
      // named wildcard understood by Nest's legacy route converter.
      // `onboarding` is therefore explicitly excluded too: the first-run wizard
      // runs before any tenant exists (migration 002 pre-tenant setup role),
      // so there is no tenant context to bind.
      .exclude(
        { path: 'health', method: RequestMethod.ALL },
        { path: 'onboarding', method: RequestMethod.ALL },
        { path: 'onboarding/{*path}', method: RequestMethod.ALL },
      )
      .forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
