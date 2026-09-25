// Episodes endpoint — thin HTTP skin over `salud.service.ts`
// (bases-consolidadas-v1.md §2.3, §3.3). The service owns scope, state and
// audit; the controller only maps request data to the use case.
import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import {
  actorFromRequest,
  closeEpisode,
  createEpisode,
  getEpisode,
  listEpisodes,
  type EpisodeRecord,
} from './salud.service.ts';

@Controller('salud/episodes')
export class EpisodesController {
  /** `GET /v1/salud/episodes` — episodes of patients in the caller scope. */
  @Get()
  list(@Req() req: TenantScopedRequest): Promise<EpisodeRecord[]> {
    return listEpisodes(actorFromRequest(req));
  }

  /** `POST /v1/salud/episodes` — open an episode (`episode.write`). */
  @Post()
  create(@Req() req: TenantScopedRequest, @Body() body: unknown): Promise<EpisodeRecord> {
    return createEpisode(actorFromRequest(req), body);
  }

  /** `GET /v1/salud/episodes/:id` — read one episode within scope. */
  @Get(':id')
  get(@Req() req: TenantScopedRequest, @Param('id') id: string): Promise<EpisodeRecord> {
    return getEpisode(actorFromRequest(req), id);
  }

  /** `PATCH /v1/salud/episodes/:id` — close an episode (`episode.write`). */
  @Patch(':id')
  close(@Req() req: TenantScopedRequest, @Param('id') id: string): Promise<EpisodeRecord> {
    return closeEpisode(actorFromRequest(req), id);
  }
}
