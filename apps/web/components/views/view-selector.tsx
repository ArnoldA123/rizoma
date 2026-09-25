'use client';

import type { SavedViewEntity, SavedViewRecord } from '@rizoma/contracts';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { listSavedViews } from '@/lib/views-api';
import { useResource } from '@/lib/use-resource';

/**
 * Saved-view picker for a list screen (B1, no visual editor).
 *
 * The screen owns the selected id and appends it to its own list read as
 * `?saved_view_id=`; this component only lists the views of `entity` (own
 * plus shared) and reports the pick. An empty pick means "no view": the
 * listing reads unfiltered. The component never filters rows itself — the API
 * applies the exact-equality bag server-side.
 *
 * Screens wire it with one line each (outside this task's surface), e.g. the
 * patients browser:
 *   `<ViewSelector entity="patients" selectedId={viewId} onSelect={setViewId} />`
 * and pass `viewId` into their list read once the listing accepts the param.
 */
export interface ViewSelectorProps {
  /** List entity the picker serves (`patients`, `appointments`, …). */
  readonly entity: SavedViewEntity;
  /** Currently applied view id, or `null` for the unfiltered list. */
  readonly selectedId: string | null;
  readonly onSelect: (viewId: string | null) => void;
  readonly className?: string;
}

export function ViewSelector({ entity, selectedId, onSelect, className }: ViewSelectorProps) {
  const views = useResource<SavedViewRecord[]>(`saved-views:${entity}`, (signal) =>
    listSavedViews({ entity }, signal),
  );
  const rows = views.data ?? [];

  return (
    <div className={className}>
      <label htmlFor={`saved-view-${entity}`} className="sr-only">
        Vista guardada
      </label>
      {views.loading ? (
        <Skeleton className="h-9.5 w-full sm:max-w-xs" />
      ) : (
        <Select
          id={`saved-view-${entity}`}
          className="sm:max-w-xs"
          value={selectedId ?? ''}
          disabled={views.failure !== null}
          onChange={(event) => {
            const next = event.target.value;
            onSelect(next === '' ? null : next);
          }}
        >
          <option value="">Sin vista guardada</option>
          {rows.map((row) => (
            <option key={row.id} value={row.id}>
              {describeView(row)}
            </option>
          ))}
        </Select>
      )}
      {views.failure !== null ? (
        <p className="mt-1 text-xs text-muted-foreground">
          No se pudieron leer las vistas guardadas.{' '}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={views.reload}
          >
            Reintentar
          </button>
        </p>
      ) : null}
      {!views.loading && views.failure === null && rows.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Todavía no hay vistas guardadas para esta lista.
        </p>
      ) : null}
    </div>
  );
}

/** One-line label: filter summary plus the shared marker. */
function describeView(row: SavedViewRecord): string {
  const entries = Object.entries(row.filters);
  const summary =
    entries.length === 0
      ? 'sin filtros'
      : entries
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(', ');
  return `${summary}${row.shared ? ' (compartida)' : ''}${row.active ? '' : ' (inactiva)'}`;
}
