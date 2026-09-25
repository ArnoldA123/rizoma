// Assets endpoint — thin HTTP skin over `resources.service.ts`
// (bases-consolidadas-v1.md §2.4, §3.4). The state machine, the site guard and
// the write audit stay in the service; each handler only forwards the
// request-bound tenant client.
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import { actorFromRequest } from './obras.service.ts';
import {
  assignAsset,
  listAssets,
  listAssetsPage,
  recordReading,
  registerAsset,
  retireAsset,
  setMaintenance,
  type AssetReadingRecord,
  type AssetRecord,
  type ResourcePage,
} from './resources.service.ts';

/** Paged envelope returned only when the caller sends `?cursor=` or `?limit=`. */
export type AssetPage = ResourcePage<AssetRecord>;

/** Non-empty query param, or null when absent/blank (legacy bare-array path). */
function readPageParam(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

@Controller('obras/assets')
export class AssetsController {
  /**
   * `GET /v1/obras/assets` — units inside the membership subtree, capped at 200.
   * Without `?cursor=`/`?limit=` answers the legacy bare array; with either,
   * answers the keyset page `{rows, nextCursor}` ordered by
   * `code ASC, id ASC`.
   */
  @Get()
  list(
    @Req() req: TenantScopedRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<AssetRecord[] | AssetPage> {
    const pageCursor = readPageParam(cursor);
    const pageLimit = readPageParam(limit);
    if (pageCursor === null && pageLimit === null) {
      return listAssets(actorFromRequest(req));
    }
    return listAssetsPage(actorFromRequest(req), { cursor: pageCursor, limit: pageLimit });
  }

  /** `POST /v1/obras/assets` — register an equipment unit (`site.write`). */
  @Post()
  register(@Req() req: TenantScopedRequest, @Body() body: unknown): Promise<AssetRecord> {
    return registerAsset(actorFromRequest(req), body);
  }

  /** `POST /v1/obras/assets/:id/assign` — assign to a site (`assignment.write`). */
  @Post(':id/assign')
  @HttpCode(200)
  assign(
    @Req() req: TenantScopedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AssetRecord> {
    return assignAsset(actorFromRequest(req), id, body);
  }

  /** `POST /v1/obras/assets/:id/maintenance` — send to maintenance (`site.write`). */
  @Post(':id/maintenance')
  @HttpCode(200)
  maintain(@Req() req: TenantScopedRequest, @Param('id') id: string): Promise<AssetRecord> {
    return setMaintenance(actorFromRequest(req), id);
  }

  /** `POST /v1/obras/assets/:id/retire` — retire the unit (`site.write`). */
  @Post(':id/retire')
  @HttpCode(200)
  retire(@Req() req: TenantScopedRequest, @Param('id') id: string): Promise<AssetRecord> {
    return retireAsset(actorFromRequest(req), id);
  }

  /** `POST /v1/obras/assets/:id/readings` — append a manual reading. */
  @Post(':id/readings')
  reading(
    @Req() req: TenantScopedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AssetReadingRecord> {
    return recordReading(actorFromRequest(req), id, body);
  }
}
