// Stock endpoint — thin HTTP skin over `resources.service.ts`
// (bases-consolidadas-v1.md §2.4, §3.4). The warehouse guard, the posted-stock
// validation and the audit stay in the service.
import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import { actorFromRequest } from './obras.service.ts';
import {
  createItem,
  postStockMove,
  reverseMove,
  type InventoryItemRecord,
  type StockMoveRecord,
} from './resources.service.ts';

@Controller('obras/stock')
export class StockController {
  /** `POST /v1/obras/stock/items` — create a warehouse item (`stock.consume`). */
  @Post('items')
  createItem(@Req() req: TenantScopedRequest, @Body() body: unknown): Promise<InventoryItemRecord> {
    return createItem(actorFromRequest(req), body);
  }

  /** `POST /v1/obras/stock/moves` — register and post a move (`stock.consume`). */
  @Post('moves')
  postMove(@Req() req: TenantScopedRequest, @Body() body: unknown): Promise<StockMoveRecord> {
    return postStockMove(actorFromRequest(req), body);
  }

  /** `POST /v1/obras/stock/moves/:id/reverse` — reverse a posted move. */
  @Post('moves/:id/reverse')
  @HttpCode(200)
  reverse(@Req() req: TenantScopedRequest, @Param('id') id: string): Promise<StockMoveRecord> {
    return reverseMove(actorFromRequest(req), id);
  }
}
