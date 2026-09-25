// Stock endpoint — thin HTTP skin over `resources.service.ts`
// (bases-consolidadas-v1.md §2.4, §3.4). The warehouse guard, the posted-stock
// validation and the audit stay in the service.
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import { actorFromRequest } from './obras.service.ts';
import {
  createItem,
  listItems,
  listMoves,
  listMovesPage,
  postStockMove,
  reverseMove,
  type InventoryItemRecord,
  type ResourcePage,
  type StockMoveRecord,
} from './resources.service.ts';

/** Paged envelope returned only when the caller sends `?cursor=` or `?limit=`. */
export type StockMovePage = ResourcePage<StockMoveRecord>;

/** Non-empty query param, or null when absent/blank (legacy bare-array path). */
function readPageParam(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

@Controller('obras/stock')
export class StockController {
  /** `GET /v1/obras/stock/items` — warehouse items, capped at 200. */
  @Get('items')
  items(@Req() req: TenantScopedRequest): Promise<InventoryItemRecord[]> {
    return listItems(actorFromRequest(req));
  }

  /**
   * `GET /v1/obras/stock/moves` — moves of subtree warehouses, capped at 200.
   * Without `?cursor=`/`?limit=` answers the legacy bare array; with either,
   * answers the keyset page `{rows, nextCursor}` ordered by
   * `at DESC, id DESC`.
   */
  @Get('moves')
  moves(
    @Req() req: TenantScopedRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<StockMoveRecord[] | StockMovePage> {
    const pageCursor = readPageParam(cursor);
    const pageLimit = readPageParam(limit);
    if (pageCursor === null && pageLimit === null) {
      return listMoves(actorFromRequest(req));
    }
    return listMovesPage(actorFromRequest(req), { cursor: pageCursor, limit: pageLimit });
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
