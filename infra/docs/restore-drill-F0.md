# Runbook — Restore drill F0 (`rizoma`)

Criterio de salida F0 #4: *restore drill ejecutado y documentado*.

## Propósito

Demostrar que la base de datos `rizoma` de la fundación (migraciones `001` y
`002` aplicadas) se puede respaldar, restaurar en una base limpia y verificar
estructuralmente, sin depender de la bóveda de secretos ni de procesos manuales
no reproducibles.

El drill valida el respaldo lógico (`pg_dump`/restore) del esquema y la
configuración de aislamiento por tenant (RLS). No valida recuperación
point-in-time, cifrado en reposo del dump ni retención: esos puntos se cubrirán
en fases posteriores.

## Alcance

- Origen: base `rizoma` en el Postgres local (conexión directa `127.0.0.1:5432`).
- Destino: base de descarte `rizoma_restore_f0_<UTC>` creada y destruida por el
  propio drill.
- Script único: `scripts/backup/restore_drill.sh` (`npm run backup:drill`).

## Prerrequisitos

1. Stack local levitado y sano:
   `docker compose -f infra/docker/compose.yml --env-file infra/docker/.env up -d`
   (postgres 5432, pgbouncer 6432, redis 6379, keycloak 8080/9000, s3 4566).
2. Migraciones `001` y `002` aplicadas en `rizoma`. Si faltan, se aplican con
   el procedimiento manual documentado en `db/README.md`:

   ```bash
   psql postgresql://rizoma:rizoma_demo_password@localhost:5432/rizoma \
     -v ON_ERROR_STOP=1 -f db/migrations/001_core_foundation.sql
   psql postgresql://rizoma:rizoma_demo_password@localhost:5432/rizoma \
     -v ON_ERROR_STOP=1 -f db/migrations/002_onboarding.sql
   ```

   > Nota de ejecución: la base `rizoma` de desarrollo estaba vacía al ejecutar
   > este drill; se aplicaron `001` y `002` con los comandos anteriores antes de
   > la corrida. Es una operación idempotente y no destructiva.
3. Cliente `psql` en el host. Para el `pg_dump`, el script prefiere el binario
   del contenedor `postgres` (misma versión mayor que el servidor: 16.15) y cae
   al `pg_dump` del host solo si el contenedor no está disponible.
4. Permisos para crear y borrar bases de descarte (el usuario `rizoma` es
   superusuario en local).

## Pasos

1. Ejecutar el drill: `npm run backup:drill` (o `bash scripts/backup/restore_drill.sh`).
2. El script:
   1. verifica que `rizoma` tenga `001_core_foundation` y `002_onboarding`;
   2. genera `/tmp/rizoma-f0-<UTC>.dump` (preferentemente con el `pg_dump` del
      contenedor Postgres 16);
   3. crea la base `rizoma_restore_f0_<UTC>`;
   4. restaura el dump con `psql -v ON_ERROR_STOP=1`;
   5. verifica el esquema restaurado (ver sección *Verificación*);
   6. imprime `DRILL OK` y la línea `evidence — ...`.
3. Al terminar, el script **borra la base de descarte** y **elimina el dump**,
   salvo que se exporte `KEEP_DUMP=1`:

   ```bash
   KEEP_DUMP=1 bash scripts/backup/restore_drill.sh
   ```

Variables soportadas: `POSTGRES_*`, `PG_HOST`, `PG_CONTAINER`
(nombre de contenedor o `host` para forzar el `pg_dump` del host),
`KEEP_DUMP`, `EXPECTED_CORE_POLICIES`.

## Verificación

El drill falla (salida ≠ 0, sin `DRILL OK`) si cualquiera de estos chequeos no
se cumple en la base restaurada:

| # | Chequeo | Consulta | Esperado |
|---|---------|----------|----------|
| 1 | Policies `tenant_isolation` de las tablas core de 001 | `SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname='tenant_isolation' AND tablename <> 'onboarding_acta';` | **22** |
| 2 | Policy `tenant_isolation` del acta de onboarding (002) | `... WHERE tablename = 'onboarding_acta';` | **≥ 1** |
| 3 | Migraciones aplicadas | `SELECT count(*) FROM schema_migrations WHERE version IN ('001_core_foundation','002_onboarding');` | **2** |

Total resultante: 22 policies core + 1 de `onboarding_acta` = **23** tablas con
policy `tenant_isolation`. El número 22 corresponde al conjunto de tablas core
de `001`; la 23.ª es la excepción documentada de `002` (`onboarding_acta`, tabla
de negocio con `tenant_id` + RLS).

Chequeo complementario de la fundación (no forma parte del drill): los probes
sintéticos `npm run probes` deben reportar `7/7 PASS`.

## Ventana y responsables

- **Ventana del drill:** no requiere ventana de mantenimiento. Solo crea una
  base de descarte y un archivo temporal en `/tmp`; no toca datos de la base
  `rizoma`. En un entorno compartido, ejecutarlo fuera del horario laboral o en
  el horario acordado con el responsable de la base.
- **Ejecutor técnico:** responsable de plataforma/infraestructura.
- **Aprobación:** tech lead del proyecto Rizoma.
- **Responsables por tenant:** cada responsable de tenant designa a la persona
  que valida, tras un restore real, que sus datos (usuarios, sedes, actas de
  onboarding, documentos) estén presentes y que ninguna fila sea visible sin
  `app.tenant_id` (aislamiento). Esa validación funcional es un paso humano
  posterior al drill estructural y se registra en el acta de recuperación del
  tenant.

## Evidencia del drill ejecutado

Ejecuciones reales sobre el stack local (Postgres 16.15 en
`rizoma-postgres-1`), con `001` y `002` aplicadas en `rizoma`:

| Fecha/hora UTC (inicio → fin) | Dump (bytes) | Base de restore | 001 core `tenant_isolation` | `onboarding_acta` `tenant_isolation` | `schema_migrations` 001+002 | Resultado |
|---|---|---|---|---|---|---|
| 2026-09-24T23:53:28Z → 23:53:30Z | 57707 | `rizoma_restore_f0_20260924235328` | 22 | 1 | 2 | **DRILL OK** |
| 2026-09-24T23:53:43Z → 23:53:44Z | 57707 | `rizoma_restore_f0_20260924235343` | 22 | 1 | 2 | **DRILL OK** |

- La primera corrida se hizo con `bash scripts/backup/restore_drill.sh`; la
  segunda, con `npm run backup:drill`, para validar el script de `package.json`.
- En ambas corridas el dump se eliminó y la base de descarte se destruyó
  (`dump removed` / `dropped restore database`).
- Probe sintético en la misma sesión: `npm run probes` → `F0 PROBES: 7/7 PASS`.

## Riesgos y límites conocidos

- `pg_dump` del host en versión 18 emite `SET transaction_timeout = 0;`, que
  Postgres 16 rechaza. Por eso el script prefiere el `pg_dump` del contenedor
  Postgres 16; si se fuerza `PG_CONTAINER=host` con una versión mayor que el
  servidor, el restore puede fallar.
- El drill valida esquema y políticas, no contenido de datos: la base `rizoma`
  de desarrollo está vacía. La validación con datos reales corresponde a la
  fase con entornos con carga.
- El dump no se cifra y vive en `/tmp` mientras dura la corrida; en producción
  el respaldo debe ir a almacenamiento cifrado con retención definida.
