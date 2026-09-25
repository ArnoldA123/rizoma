// API key endpoint — thin HTTP skin over `api-keys.ts` (W1).
// No domain logic and no permission checks live here: every handler forwards
// the request-bound tenant client to the service, which owns validation, the
// tenant-admin gate, the SQL and the write audit.
import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import {
  actorFromApiRequest,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyCreated,
  type ApiKeyRecord,
  type ApiKeyRequest,
} from './api-keys.ts';

@Controller('api-keys')
export class ApiKeysController {
  /** `POST /v1/api-keys` — issues one key; the secret is returned only here. */
  @Post()
  create(@Req() req: ApiKeyRequest, @Body() body: unknown): Promise<ApiKeyCreated> {
    return createApiKey(actorFromApiRequest(req), body);
  }

  /** `GET /v1/api-keys` — lists the tenant keys, newest first, without secrets. */
  @Get()
  list(@Req() req: ApiKeyRequest): Promise<ApiKeyRecord[]> {
    return listApiKeys(actorFromApiRequest(req));
  }

  /** `POST /v1/api-keys/:id/revoke` — deactivates one key (next-request effect). */
  @Post(':id/revoke')
  revoke(@Req() req: ApiKeyRequest, @Param('id') id: string): Promise<ApiKeyRecord> {
    return revokeApiKey(actorFromApiRequest(req), id);
  }
}
