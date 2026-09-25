// Saved-view endpoint — thin HTTP skin over `views.service.ts` (B1).
// No domain logic and no permission checks live here: every handler forwards
// the request-bound tenant client to the service, which owns validation, the
// tenant+owner scope, the SQL and the write audit.
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  actorFromViewsRequest,
  createSavedView,
  getSavedView,
  listSavedViews,
  removeSavedView,
  updateSavedView,
  type SavedViewRecord,
  type ViewsRequest,
} from './views.service.ts';

@Controller('views')
export class ViewsController {
  /** `POST /v1/views` — stores one filter bag for one list entity. */
  @Post()
  create(@Req() req: ViewsRequest, @Body() body: unknown): Promise<SavedViewRecord> {
    return createSavedView(actorFromViewsRequest(req), body);
  }

  /** `GET /v1/views` — own active views plus shared ones; `?entity=` narrows. */
  @Get()
  list(@Req() req: ViewsRequest, @Query('entity') entity?: string): Promise<SavedViewRecord[]> {
    return listSavedViews(actorFromViewsRequest(req), { entity });
  }

  /** `GET /v1/views/:id` — one visible view (foreign private views are 404). */
  @Get(':id')
  get(@Req() req: ViewsRequest, @Param('id') id: string): Promise<SavedViewRecord> {
    return getSavedView(actorFromViewsRequest(req), id);
  }

  /** `PATCH /v1/views/:id` — owner only; shared views of others are 403. */
  @Patch(':id')
  update(
    @Req() req: ViewsRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SavedViewRecord> {
    return updateSavedView(actorFromViewsRequest(req), id, body);
  }

  /** `DELETE /v1/views/:id` — owner only, soft delete (`active = FALSE`). */
  @Delete(':id')
  remove(@Req() req: ViewsRequest, @Param('id') id: string): Promise<SavedViewRecord> {
    return removeSavedView(actorFromViewsRequest(req), id);
  }
}
