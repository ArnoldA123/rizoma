// Stock endpoint — thin HTTP skin over `resources.service.ts`
// (bases-consolidadas-v1.md §2.4, §3.4). The warehouse guard, the posted-stock
// validation and the audit stay in the service.
import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import { actorFromRequest } from './obras.service.ts';
import {
  createItem,
  listItems,
  listMoves,
  postStockMove,
  reverseMove,
  type InventoryItemRecord,
  type StockMoveRecord,
} from './resources.service.ts';

@Controller('obras/stock')
export class StockController {
  /** `GET /v1/obras/stock/items` — warehouse items, capped at 200. */
  @Get('items')
  items(@Req() req: TenantScopedRequest): Promise<InventoryItemRecord[]> {
    return listItems(actorFromRequest(req));
  }

  /** `GET /v1/obras/stock/moves` — moves of subtree warehouses, capped at 200. */
  @Get('moves')
  moves(@Req() req: TenantScopedRequest): Promise<StockMoveRecord[]> {
    return listMoves(actorFromRequest(req));
  }

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
