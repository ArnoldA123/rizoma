// Files endpoint — thin HTTP skin over `files.service.ts` (H2, bases §4.5).
// No domain logic and no permission checks live here: every handler forwards
// the request-bound tenant client to the service, which owns validation, the
// guard, the canonical key and the write audit.
import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import { actorFromRequest } from '../salud/salud.service.ts';
import {
  getFileDownload,
  requestFileUpload,
  type FileDownloadGrant,
  type FileUploadGrant,
} from './files.service.ts';

@Controller('files')
export class FilesController {
  /** `POST /v1/files/request-upload` — register the row and mint a PUT URL. */
  @Post('request-upload')
  requestUpload(
    @Req() req: TenantScopedRequest,
    @Body() body: unknown,
  ): Promise<FileUploadGrant> {
    return requestFileUpload(actorFromRequest(req), body);
  }

  /** `GET /v1/files/:id/download` — authorize and mint a GET URL (≤5 min). */
  @Get(':id/download')
  getDownload(
    @Req() req: TenantScopedRequest,
    @Param('id') id: string,
  ): Promise<FileDownloadGrant> {
    return getFileDownload(actorFromRequest(req), id);
  }
}
