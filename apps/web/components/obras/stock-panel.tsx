'use client';

import { useMemo, useState, type FormEvent } from 'react';
import {
  ITEM_NAME_MAX,
  ITEM_SKU_MAX,
  ITEM_UNIT_MAX,
  STOCK_MOVE_KINDS,
  checkNumberField,
  checkPositiveNumberField,
  checkRequiredText,
  checkUuidField,
  firstIssue,
  stockMoveCanBeReversed,
  stockMoveSignedQty,
  type FieldCheck,
  type InventoryItemRecord,
  type StockMoveKind,
  type StockMoveRecord,
} from '@rizoma/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { LiveField } from '@/components/ui/field-feedback';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, FailurePanel, WriteResult } from '@/components/ui/states';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { formatQuantity, formatUtcStamp } from '@/lib/format';
import { stockMoveKindLabel, stockMoveStatusLabel, stockMoveStatusVariant } from '@/lib/labels';
import {
  createStockItem,
  listInventoryItems,
  listStockMoves,
  postStockMove,
  reverseStockMove,
} from '@/lib/obras-api';
import { useResource } from '@/lib/use-resource';

/**
 * Stock: ítems de almacén, movimientos contabilizados y su reversa.
 *
 * The acceptance criterion this panel exists for is «consumo descuenta stock en
 * `posted` visible», and the service makes it literal: `POST /v1/obras/stock/moves`
 * inserts with `status = 'posted'`, so an `out` charged to this site reduces the
 * item's posted quantity the moment it is written — no approval step in between.
 * The panel therefore does two things after a move:
 *
 *   1. it re-reads the scoped lists silently (`GET /v1/obras/stock/items` and
 *      `GET /v1/obras/stock/moves`, each capped at 200 rows), so the new row
 *      appears in the tables below without losing the screen's place;
 *   2. it asks the obra board to re-read silently (`onStockChanged`), so the
 *      decrement shows up in «Stock crítico» without waiting for the 10-minute
 *      poll. An item that stays above its minimum will not appear there at all,
 *      which is the truth of that block: it lists what is *below* the minimum.
 *
 * The warehouse is named by its org node, exactly as the body requires. The guard
 * runs there (`stock.consume`), so `almacen` reaches its own warehouses without
 * an assignment — but this panel is mounted inside a ficha, and the ficha only
 * opens the operational panels after the two-step site key succeeds.
 *
 * The primary controls are plain `Button variant="primary"`: the single magnetic
 * CTA of the ficha belongs to the staff panel (W4).
 */
export interface StockPanelProps {
  readonly siteId: string;
  /** `stock.consume` — create items, post moves and reverse them. */
  readonly canConsume: boolean;
  /** Called after a posted or reversed move so the board re-reads. */
  readonly onStockChanged: () => void;
  /** Item shared with the board's critical stock; `''` means "none picked yet". */
  readonly itemId: string;
  readonly onItemIdChange: (itemId: string) => void;
  readonly className?: string;
}

interface ItemDraft {
  sku: string;
  name: string;
  unit: string;
  minStock: string;
}

interface MoveDraft {
  warehouseNodeId: string;
  kind: StockMoveKind;
  qty: string;
}

const EMPTY_ITEM: ItemDraft = { sku: '', name: '', unit: '', minStock: '' };
const EMPTY_MOVE: MoveDraft = { warehouseNodeId: '', kind: 'out', qty: '' };

export function StockPanel({
  siteId,
  canConsume,
  onStockChanged,
  itemId,
  onItemIdChange,
  className,
}: StockPanelProps) {
  const [item, setItem] = useState<ItemDraft>(EMPTY_ITEM);
  const [move, setMove] = useState<MoveDraft>(EMPTY_MOVE);
  const [lastItem, setLastItem] = useState<InventoryItemRecord | null>(null);

  /** Scoped lists: tenant items and the moves of subtree warehouses. */
  const catalogue = useResource<InventoryItemRecord[]>('obras-stock-items', (signal) =>
    listInventoryItems(signal),
  );
  const ledger = useResource<StockMoveRecord[]>('obras-stock-moves', (signal) =>
    listStockMoves(signal),
  );
  const catalogueRows = catalogue.data ?? [];
  const ledgerRows = ledger.data ?? [];
  /** Moves of the picked item first, so the board shortcut reads as a filter. */
  const orderedMoves = useMemo(() => {
    if (itemId === '') return ledgerRows;
    return [...ledgerRows].sort((a, b) => {
      const aPicked = a.itemId === itemId ? 0 : 1;
      const bPicked = b.itemId === itemId ? 0 : 1;
      return aPicked - bPicked;
    });
  }, [ledgerRows, itemId]);
  const [touched, setTouched] = useState<Readonly<Record<string, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const itemChecks: Readonly<Record<string, FieldCheck>> = useMemo(
    () => ({
      sku: checkRequiredText('sku', item.sku, ITEM_SKU_MAX),
      name: checkRequiredText('name', item.name, ITEM_NAME_MAX),
      unit: checkRequiredText('unit', item.unit, ITEM_UNIT_MAX),
      // Optional: an untouched minimum means «the default of the API», which is 0.
      minStock: item.minStock.trim() === '' ? null : checkNumberField('minStock', item.minStock),
    }),
    [item],
  );
  const moveChecks: Readonly<Record<string, FieldCheck>> = useMemo(
    () => ({
      itemId: checkUuidField('itemId', itemId),
      warehouseNodeId: checkUuidField('warehouseNodeId', move.warehouseNodeId),
      qty: checkPositiveNumberField('qty', move.qty),
    }),
    [itemId, move],
  );

  const show = (field: string): boolean => touched[field] === true || submitted;

  function touch(field: string): void {
    setTouched((current) => ({ ...current, [field]: true }));
  }

  function start(): void {
    setFailure(null);
    setSuccess(null);
  }

  async function handleItem(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitted(true);
    if (firstIssue(itemChecks) !== null) return;
    start();
    setSaving(true);
    try {
      const minStock = item.minStock.trim();
      const created = await createStockItem({
        sku: item.sku.trim(),
        name: item.name.trim(),
        unit: item.unit.trim(),
        minStock: minStock === '' ? 0 : Number(minStock),
      });
      setLastItem(created);
      catalogue.reloadSilently();
      onItemIdChange(created.id);
      setItem(EMPTY_ITEM);
      setTouched({});
      setSubmitted(false);
      setSuccess(
        `Ítem ${created.sku} creado con mínimo ${formatQuantity(created.minStock)} ${created.unit}. El SKU es único en el tenant: repetirlo responde obra.duplicate.`,
      );
    } catch (error) {
      setFailure(classifyApiError(error));
    } finally {
      setSaving(false);
    }
  }

  async function handleMove(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitted(true);
    if (firstIssue(moveChecks) !== null) return;
    start();
    setSaving(true);
    try {
      const created = await postStockMove({
        itemId: itemId.trim(),
        warehouseNodeId: move.warehouseNodeId.trim(),
        // Only a consumption is charged to a site; an entry or a transfer between
        // warehouses is not «de esta obra» and travels with `siteId: null`.
        siteId: move.kind === 'out' ? siteId : null,
        qty: Number(move.qty.trim()),
        kind: move.kind,
      });
      ledger.reloadSilently();
      setMove((current) => ({ ...current, qty: '' }));
      setTouched({});
      setSubmitted(false);
      onStockChanged();
      setSuccess(
        created.kind === 'out'
          ? `Consumo de ${formatQuantity(created.qty)} contabilizado (${stockMoveStatusLabel(created.status)}) sobre la obra. El movimiento nace «posted», así que el stock disponible del almacén ya lo descontó; el tablero se relee para reflejarlo.`
          : `Movimiento «${stockMoveKindLabel(created.kind)}» de ${formatQuantity(created.qty)} contabilizado. Un movimiento se registra y se contabiliza en un solo paso: no hay estado borrador que aprobar.`,
      );
    } catch (error) {
      setFailure(classifyApiError(error));
    } finally {
      setSaving(false);
    }
  }

  async function handleReverse(row: StockMoveRecord): Promise<void> {
    start();
    setSaving(true);
    try {
      const reversed = await reverseStockMove(row.id);
      ledger.reloadSilently();
      onStockChanged();
      setSuccess(
        `Movimiento revertido (${stockMoveStatusLabel(reversed.status)}). La fila original no se borra: queda con estado «Revertido», que es lo que devuelve la cantidad al almacén.`,
      );
    } catch (error) {
      setFailure(classifyApiError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className={className} id="stock-obra">
      <CardHeader>
        <CardEyebrow>Almacén</CardEyebrow>
        <CardTitle as="h2">Stock y consumo</CardTitle>
        <CardDescription>
          Un consumo se contabiliza al registrarse y descuenta el stock del almacén del nodo indicado.
          Un `out` o una `transfer` que supere el stock contabilizado responde{' '}
          <code className="font-mono">obra.insufficient_stock</code>: el API no permite dejar el
          almacén en negativo.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        {canConsume ? (
          <form className="flex flex-col gap-4" onSubmit={handleItem} noValidate>
            <p className="text-xs text-muted-foreground">
              El ítem se crea a nivel de organización: el almacén no necesita asignación a la obra,
              y el panel solo aparece dentro de la ficha cuando la clave de acceso a la obra ya se
              resolvió.
            </p>
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground underline underline-offset-2">
                Copiar detalle
              </summary>
              <pre className="tabular mt-2 overflow-x-auto rounded-md border border-border bg-secondary p-2 font-mono break-all whitespace-pre-wrap">
                {`action: stock.consume`}
              </pre>
            </details>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <LiveField id="item-sku" label="SKU" issue={itemChecks.sku ?? null} touched={show('sku')} hint="Único en el tenant.">
                <Input
                  id="item-sku"
                  maxLength={ITEM_SKU_MAX}
                  placeholder="CEM-01"
                  value={item.sku}
                  onChange={(event) => setItem((current) => ({ ...current, sku: event.target.value }))}
                  onBlur={() => touch('sku')}
                />
              </LiveField>
              <LiveField id="item-name" label="Nombre" issue={itemChecks.name ?? null} touched={show('name')}>
                <Input
                  id="item-name"
                  maxLength={ITEM_NAME_MAX}
                  placeholder="Cemento Portland"
                  value={item.name}
                  onChange={(event) => setItem((current) => ({ ...current, name: event.target.value }))}
                  onBlur={() => touch('name')}
                />
              </LiveField>
              <LiveField id="item-unit" label="Unidad" issue={itemChecks.unit ?? null} touched={show('unit')}>
                <Input
                  id="item-unit"
                  maxLength={ITEM_UNIT_MAX}
                  placeholder="bolsa"
                  value={item.unit}
                  onChange={(event) => setItem((current) => ({ ...current, unit: event.target.value }))}
                  onBlur={() => touch('unit')}
                />
              </LiveField>
              <LiveField
                id="item-min"
                label="Stock mínimo"
                issue={itemChecks.minStock ?? null}
                touched={show('minStock')}
                hint="Vacío equivale a 0, el valor por defecto del API."
              >
                <Input
                  id="item-min"
                  inputMode="decimal"
                  placeholder="0"
                  value={item.minStock}
                  onChange={(event) => setItem((current) => ({ ...current, minStock: event.target.value }))}
                  onBlur={() => touch('minStock')}
                />
              </LiveField>
            </div>
            <div>
              <Button variant="primary" size="sm" type="submit" disabled={saving}>
                {saving ? 'Creando…' : 'Crear ítem'}
              </Button>
            </div>
          </form>
        ) : null}

        {canConsume ? (
          <form
            className="flex flex-col gap-4 border-t border-border pt-4"
            onSubmit={handleMove}
            noValidate
          >
            <div className="grid gap-4 sm:grid-cols-3">
              <LiveField
                id="move-item"
                label="Ítem (UUID)"
                issue={moveChecks.itemId ?? null}
                touched={show('itemId') || itemId !== ''}
                hint="Se completa al elegir una fila de la tabla o un ítem del stock crítico del tablero."
              >
                <Input
                  id="move-item"
                  className="font-mono text-xs"
                  spellCheck={false}
                  placeholder="UUID del ítem"
                  value={itemId}
                  onChange={(event) => {
                    onItemIdChange(event.target.value);
                    setSuccess(null);
                  }}
                  onBlur={() => touch('itemId')}
                />
              </LiveField>
              <LiveField
                id="move-warehouse"
                label="Almacén (nodo de organización)"
                issue={moveChecks.warehouseNodeId ?? null}
                touched={show('warehouseNodeId')}
                hint="Nodo donde se contabiliza el movimiento; el guard corre allí."
              >
                <Input
                  id="move-warehouse"
                  className="font-mono text-xs"
                  spellCheck={false}
                  placeholder="UUID del nodo"
                  value={move.warehouseNodeId}
                  onChange={(event) =>
                    setMove((current) => ({ ...current, warehouseNodeId: event.target.value }))
                  }
                  onBlur={() => touch('warehouseNodeId')}
                />
              </LiveField>
              <div className="grid grid-cols-2 gap-4">
                <LiveField id="move-kind" label="Tipo" issue={null} touched={false}>
                  <Select
                    id="move-kind"
                    value={move.kind}
                    onChange={(event) =>
                      setMove((current) => ({ ...current, kind: event.target.value as StockMoveKind }))
                    }
                  >
                    {STOCK_MOVE_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {stockMoveKindLabel(kind)}
                      </option>
                    ))}
                  </Select>
                </LiveField>
                <LiveField id="move-qty" label="Cantidad" issue={moveChecks.qty ?? null} touched={show('qty')}>
                  <Input
                    id="move-qty"
                    inputMode="decimal"
                    placeholder="2"
                    value={move.qty}
                    onChange={(event) => setMove((current) => ({ ...current, qty: event.target.value }))}
                    onBlur={() => touch('qty')}
                  />
                </LiveField>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" size="sm" type="submit" disabled={saving}>
                {saving ? 'Registrando…' : 'Registrar movimiento'}
              </Button>
              <span className="text-xs text-muted-foreground">
                {move.kind === 'out'
                  ? 'Un consumo se carga a esta obra (siteId de la ficha) y descuenta el stock contabilizado.'
                  : 'Un ingreso o una transferencia no se cargan a esta obra: viajan con siteId nulo.'}
              </span>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">
              Su rol no puede crear ítems ni registrar movimientos en esta obra: esas opciones no
              se ofrecen. Si necesita este acceso, avise a jefatura o a soporte.
            </p>
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground underline underline-offset-2">
                Copiar detalle
              </summary>
              <pre className="tabular mt-2 overflow-x-auto rounded-md border border-border bg-secondary p-2 font-mono break-all whitespace-pre-wrap">
                {`code: obra.scope_denied\nstatus: 403\naction: stock.consume`}
              </pre>
            </details>
          </div>
        )}

        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[0.8125rem] font-medium">Ítems del almacén</span>
            <span className="tabular ml-auto text-xs text-muted-foreground">
              {catalogue.loading ? 'leyendo…' : `${catalogueRows.length} ítems`}
            </span>
            <Button variant="ghost" size="sm" onClick={catalogue.reload} disabled={catalogue.loading}>
              Actualizar
            </Button>
          </div>

          {catalogue.loading ? <StockSkeleton /> : null}

          {!catalogue.loading && catalogue.failure !== null ? (
            <FailurePanel
              title="No se pudo leer los ítems del almacén"
              failure={catalogue.failure}
              onRetry={catalogue.reload}
            />
          ) : null}

          {!catalogue.loading && catalogue.failure === null && catalogueRows.length === 0 ? (
            <EmptyState
              eyebrow="Sin ítems"
              title="El almacén no tiene ítems"
              description={lastItem === null
                ? 'El API respondió con una lista válida y vacía. El primer ítem se crea con el formulario de arriba; el SKU es único en el tenant.'
                : `El último ítem creado fue ${lastItem.sku}: la lista se relee sola después de cada alta.`}
            />
          ) : null}

          {!catalogue.loading && catalogue.failure === null && catalogueRows.length > 0 ? (
            <ul className="flex flex-col">
              {catalogueRows.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="tabular text-[0.8125rem] font-medium">{row.sku}</span>
                      <span className="text-xs text-muted-foreground">{row.name}</span>
                      {itemId === row.id ? <Badge variant="outline">elegido</Badge> : null}
                    </div>
                    <span className="tabular text-xs text-muted-foreground">
                      mínimo {formatQuantity(row.minStock)} {row.unit}
                    </span>
                    <span className="tabular font-mono text-[0.6875rem] text-muted-foreground">
                      ítem {row.id}
                    </span>
                  </div>
                  <Button
                    variant={itemId === row.id ? 'primary' : 'outline'}
                    size="sm"
                    disabled={itemId === row.id}
                    onClick={() => {
                      onItemIdChange(row.id);
                      setSuccess(null);
                    }}
                  >
                    {itemId === row.id ? 'Elegido' : 'Elegir'}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[0.8125rem] font-medium">Movimientos del alcance</span>
            <span className="tabular ml-auto text-xs text-muted-foreground">
              {ledger.loading ? 'leyendo…' : `${ledgerRows.length} movimientos`}
            </span>
            <Button variant="ghost" size="sm" onClick={ledger.reload} disabled={ledger.loading}>
              Actualizar
            </Button>
          </div>
          <p className="tabular text-xs text-muted-foreground">
            Máximo 200 filas, las más recientes primero; al elegir un ítem sus movimientos suben
            arriba. El stock disponible real lo reporta el tablero.
          </p>

          {ledger.loading ? <StockSkeleton /> : null}

          {!ledger.loading && ledger.failure !== null ? (
            <FailurePanel
              title="No se pudo leer los movimientos del alcance"
              failure={ledger.failure}
              onRetry={ledger.reload}
            />
          ) : null}

          {!ledger.loading && ledger.failure === null && ledgerRows.length === 0 ? (
            <EmptyState
              eyebrow="Sin movimientos"
              title="Todavía no hay movimientos en el alcance"
              description="El API respondió con una lista válida y vacía. El primer movimiento se registra con el formulario de arriba y nace contabilizado."
            />
          ) : null}

          {!ledger.loading && ledger.failure === null && ledgerRows.length > 0 ? (
            <ul className="flex flex-col">
              {orderedMoves.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{stockMoveKindLabel(row.kind)}</Badge>
                      <Badge variant={stockMoveStatusVariant(row.status)}>
                        {stockMoveStatusLabel(row.status)}
                      </Badge>
                      <span className="tabular text-[0.8125rem] font-medium">
                        {stockMoveSignedQty(row) > 0 ? '+' : ''}
                        {formatQuantity(stockMoveSignedQty(row))}
                      </span>
                      {row.siteId === siteId ? <Badge variant="outline">esta obra</Badge> : null}
                    </div>
                    <span className="tabular font-mono text-[0.6875rem] text-muted-foreground">
                      movimiento {row.id} · ítem {row.itemId}
                      {row.siteId === null ? '' : ` · obra ${row.siteId}`} · {formatUtcStamp(row.at)}
                    </span>
                  </div>
                  {canConsume && stockMoveCanBeReversed(row) ? (
                    <Button variant="outline" size="sm" disabled={saving} onClick={() => void handleReverse(row)}>
                      Revertir
                    </Button>
                  ) : row.status === 'reversed' ? (
                    <span className="text-xs text-muted-foreground">
                      revertido: un movimiento se revierte una sola vez
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <WriteResult failure={failure} success={success} />
      </CardContent>
    </Card>
  );
}

function StockSkeleton() {
  return (
    <ul aria-hidden className="flex flex-col">
      {[0, 1].map((index) => (
        <li key={index} className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0">
          <Skeleton className="ob-shimmer h-3 w-40" delay={index * 90} />
          <Skeleton className="ob-shimmer h-3 w-full max-w-xl" delay={index * 90 + 60} />
          <Skeleton className="ob-shimmer h-2.5 w-56" delay={index * 90 + 120} />
        </li>
      ))}
    </ul>
  );
}
