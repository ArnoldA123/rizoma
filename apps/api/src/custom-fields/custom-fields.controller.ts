// Custom-field endpoint — thin HTTP skin over `custom-fields.service.ts`
// (B2). No domain logic and no permission checks live here: every handler
// forwards the request-bound tenant client to the service, which owns the
// tenant-admin gate, the SQL and the write audit.
import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { CustomFieldRequest } from './custom-fields.service.ts';
import {
  actorFromCustomFieldRequest,
  createCustomField,
  getCustomField,
  listCustomFields,
  updateCustomField,
  type CustomFieldDef,
} from './custom-fields.service.ts';

@Controller('custom-fields')
export class CustomFieldsController {
  /** `POST /v1/custom-fields` — declares one typed key (`tenant-admin`). */
  @Post()
  create(@Req() req: CustomFieldRequest, @Body() body: unknown): Promise<CustomFieldDef> {
    return createCustomField(actorFromCustomFieldRequest(req), body);
  }

  /** `GET /v1/custom-fields` — tenant definitions (`?module=&entity=&status=`). */
  @Get()
  list(@Req() req: CustomFieldRequest, @Query() query: unknown): Promise<CustomFieldDef[]> {
    return listCustomFields(actorFromCustomFieldRequest(req), query);
  }

  /** `GET /v1/custom-fields/:id` — one definition of the tenant. */
  @Get(':id')
  get(@Req() req: CustomFieldRequest, @Param('id') id: string): Promise<CustomFieldDef> {
    return getCustomField(actorFromCustomFieldRequest(req), id);
  }

  /** `PATCH /v1/custom-fields/:id` — retargets `type`/`required`/`status`. */
  @Patch(':id')
  update(
    @Req() req: CustomFieldRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CustomFieldDef> {
    return updateCustomField(actorFromCustomFieldRequest(req), id, body);
  }
}
