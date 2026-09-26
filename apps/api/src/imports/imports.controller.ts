// Import-job listing endpoint — thin HTTP skin over `imports.service.ts`
// (P2-4a). No domain logic and no permission checks live here: every handler
// forwards the request-bound tenant client to the service, which owns the
// guard, the filters and the SQL.
//
// Route note: the CSV importers live in `obras/import.controller.ts`
// (`/v1/obras/imports/*`) and `salud/import.controller.ts`
// (`/v1/salud/imports/*`), each with a `GET :id` detail route, so a flat
// `jobs` listing cannot hang under either prefix without colliding with the
// detail param. The tenant-wide listing therefore lives here as
// `GET /v1/imports/jobs`, covering every importer kind.
import { Controller, Get, Query, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import {
  actorFromImportRequest,
  listImportJobs,
  listImportJobsPage,
  type ImportJobListItem,
  type ImportJobPage,
} from './imports.service.ts';

/** Paged envelope returned only when the caller sends `?cursor=` or `?limit=`. */
export type ImportJobsPage = ImportJobPage<ImportJobListItem>;

/** Non-empty query param, or null when absent/blank (legacy bare-array path). */
function readPageParam(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

@Controller('imports')
export class ImportJobsController {
  /**
   * `GET /v1/imports/jobs` — import jobs of the tenant (the import guard).
   * Without `?cursor=`/`?limit=` answers the legacy bare array (cap 200);
   * with either, answers the keyset page `{rows, nextCursor}` ordered by
   * `created_at DESC, id DESC`. Filters: `?kind=`, `?status=`.
   */
  @Get('jobs')
  list(
    @Req() req: TenantScopedRequest,
    @Query('kind') kind?: string,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<ImportJobListItem[] | ImportJobsPage> {
    const pageCursor = readPageParam(cursor);
    const pageLimit = readPageParam(limit);
    if (pageCursor === null && pageLimit === null) {
      return listImportJobs(actorFromImportRequest(req), { kind, status });
    }
    return listImportJobsPage(actorFromImportRequest(req), {
      kind,
      status,
      cursor: pageCursor,
      limit: pageLimit,
    });
  }
}
