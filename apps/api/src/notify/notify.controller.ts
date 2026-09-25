// Notify endpoint — thin HTTP skin over `notify.service.ts` (N1).
// No domain logic and no permission checks live here: every handler forwards
// the request-bound tenant client to the service, which owns validation, the
// tenant-admin gate, the SQL and the write audit. Delivery transitions
// (`queued → sent → delivered|failed`) belong to the worker, so the API never
// moves a message.
import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import {
  actorFromNotifyRequest,
  createTemplate,
  listMessages,
  listTemplates,
  sendNotification,
  type NotifyMessageRecord,
  type NotifyRequest,
  type NotifyTemplateRecord,
} from './notify.service.ts';

@Controller('notify')
export class NotifyController {
  /** `POST /v1/notify/send` — enqueues one notification for the caller tenant. */
  @Post('send')
  send(@Req() req: NotifyRequest, @Body() body: unknown): Promise<NotifyMessageRecord> {
    return sendNotification(actorFromNotifyRequest(req), body);
  }

  /** `GET /v1/notify/messages` — tenant messages, newest first, capped at 200. */
  @Get('messages')
  messages(
    @Req() req: NotifyRequest,
    @Query('channel') channel?: string,
    @Query('status') status?: string,
  ): Promise<NotifyMessageRecord[]> {
    return listMessages(actorFromNotifyRequest(req), { channel, status });
  }

  /** `GET /v1/notify/templates` — active templates by default (`?status=` widens). */
  @Get('templates')
  templates(
    @Req() req: NotifyRequest,
    @Query('status') status?: string,
  ): Promise<NotifyTemplateRecord[]> {
    return listTemplates(actorFromNotifyRequest(req), { status });
  }

  /** `POST /v1/notify/templates` — registers one template version. */
  @Post('templates')
  createTemplate(@Req() req: NotifyRequest, @Body() body: unknown): Promise<NotifyTemplateRecord> {
    return createTemplate(actorFromNotifyRequest(req), body);
  }
}
