// API bootstrap (bases-consolidadas-v1.md §1.2, §5.1).
//
// Boot contract:
// - Configuration is resolved during module initialization, so a missing
//   `DATABASE_URL` aborts the process instead of serving a broken instance.
// - The socket binds to loopback only: ingress belongs to the front proxy
//   (Cloudflare in production, the compose port mapping locally).
// - REST routes live under the `/v1` global prefix; probe and infra paths
//   that must stay stable across API versions are excluded from it.
// - The global ValidationPipe rejects unknown fields, so every request body is
//   validated at the edge (Zod DTOs arrive with the first domain endpoints).
// - Errors use the `{code, message, traceId}` envelope convention.
// - Shutdown hooks are enabled so SIGTERM/SIGINT run the Nest lifecycle and
//   close the shared Postgres pool (PgBouncer client) and the Redis client
//   instead of tearing the process down with sockets still open.
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.ts';
import { CONFIG_TOKEN, type ApiConfig } from './config/configuration.ts';

/** Routes that must stay reachable without the API version prefix. */
const GLOBAL_PREFIX_EXCLUDES = ['health'];

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Orderly shutdown: let Nest close the pool and the Redis client on SIGTERM
  // (container stop, `docker compose down`, Ctrl-C) before the process exits.
  app.enableShutdownHooks();

  app.setGlobalPrefix('v1', { exclude: GLOBAL_PREFIX_EXCLUDES });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const config = app.get<ApiConfig>(CONFIG_TOKEN);
  await app.listen(config.port, '127.0.0.1');
}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ code: 'api.startup_failed', message }));
  process.exitCode = 1;
});
