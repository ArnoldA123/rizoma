// Progress endpoint — thin HTTP skin over `resources.service.ts`
// (bases-consolidadas-v1.md §2.4, §3.4). Budget lines, progress entries and
// milestones share the site guard and the write audit in the service.
import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import { actorFromRequest } from './obras.service.ts';
import {
  createBudgetLine,
  listProgressEntries,
  postProgress,
  setMilestone,
  type BudgetLineRecord,
  type MilestoneRecord,
  type ProgressEntryRecord,
} from './resources.service.ts';

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
