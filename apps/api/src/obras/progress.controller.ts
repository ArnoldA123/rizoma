// Progress endpoint — thin HTTP skin over `resources.service.ts`
// (bases-consolidadas-v1.md §2.4, §3.4). Budget lines, progress entries and
// milestones share the site guard and the write audit in the service.
import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import { actorFromRequest } from './obras.service.ts';
import {
  createBudgetLine,
  listBudgetLines,
  listBudgetLinesPage,
  listProgressEntries,
  postProgress,
  setMilestone,
  type BudgetLineRecord,
  type BudgetLineWithItem,
  type MilestoneRecord,
  type ProgressEntryRecord,
  type ResourcePage,
} from './resources.service.ts';

/** Paged envelope returned only when the caller sends `?cursor=` or `?limit=`. */
export type BudgetLinePage = ResourcePage<BudgetLineWithItem>;

/** Non-empty query param, or null when absent/blank (legacy bare-array path). */
function readPageParam(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

@Controller('obras/progress')
export class ProgressController {
  /** `POST /v1/obras/progress/budget-lines` — create a budget line (`site.write`). */
  @Post('budget-lines')
  createLine(
    @Req() req: TenantScopedRequest,
    @Body() body: unknown,
  ): Promise<BudgetLineRecord> {
    return createBudgetLine(actorFromRequest(req), body);
  }

  /**
   * `GET /v1/obras/progress/budget-lines?site=` — budget lines of a site
   * (`site.read`), each with `itemSku`/`itemName` via `JOIN inventory_items`.
   * Without `?cursor=`/`?limit=` answers the legacy bare array (cap 200);
   * with either, answers the keyset page `{rows, nextCursor}` ordered by
   * `description ASC, id ASC`. Filter: `?active=`.
   *
   * NOTE: the flat `?site=` shape (not the nested
   * `/v1/obras/sites/:siteId/budget-lines`) mirrors the existing
   * `entries?site=` route: the nested path would live in `sites.controller.ts`
   * + `app.module.ts`, both outside the P2-0d edit surfaces.
   */
  @Get('budget-lines')
  listLines(
    @Req() req: TenantScopedRequest,
    @Query('site') site: string | undefined,
    @Query('active') active?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<BudgetLineWithItem[] | BudgetLinePage> {
    const pageCursor = readPageParam(cursor);
    const pageLimit = readPageParam(limit);
    if (pageCursor === null && pageLimit === null) {
      return listBudgetLines(actorFromRequest(req), site ?? '', { active });
    }
    return listBudgetLinesPage(actorFromRequest(req), site ?? '', {
      active,
      cursor: pageCursor,
      limit: pageLimit,
    });
  }

  /** `GET /v1/obras/progress/entries?site=` — posted entries of a site (`site.read`). */
  @Get('entries')
  list(
    @Req() req: TenantScopedRequest,
    @Query('site') site: string | undefined,
  ): Promise<ProgressEntryRecord[]> {
    return listProgressEntries(actorFromRequest(req), site ?? '');
  }

  /** `POST /v1/obras/progress/entries` — post a progress entry (on-site write). */
  @Post('entries')
  post(@Req() req: TenantScopedRequest, @Body() body: unknown): Promise<ProgressEntryRecord> {
    return postProgress(actorFromRequest(req), body);
  }

  /** `POST /v1/obras/progress/milestones` — set a milestone (`site.write`). */
  @Post('milestones')
  milestone(
    @Req() req: TenantScopedRequest,
    @Body() body: unknown,
  ): Promise<MilestoneRecord> {
    return setMilestone(actorFromRequest(req), body);
  }
}
