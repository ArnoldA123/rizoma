'use client';

import { useState } from 'react';
import {
  SAVED_VIEW_FILTER_KEYS,
  type SavedViewEntity,
  type SavedViewRecord,
} from '@rizoma/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { createSavedView, updateSavedView } from '@/lib/views-api';

/**
 * Minimal saved-view form (B1, no visual editor and no drag-and-drop).
 *
 * The form edits a flat bag of exact-equality filters as key/value rows: the
 * key comes from the entity allowlist, the value is typed text parsed into
 * `boolean → number → string` (so `true` and `42` keep their JSON types). A
 * `shared` checkbox controls tenant-wide visibility. On save the form calls
 * `POST /v1/views` (or `PATCH` when `initial` rides along) and reports the
 * stored row; only the owner may edit, and the API enforces it.
 */
export interface ViewFormProps {
  /** List entity the view targets; fixed for the lifetime of the form. */
  readonly entity: SavedViewEntity;
  /** Set when editing: the row being edited (must be owned by the caller). */
  readonly initial?: SavedViewRecord | null;
  readonly onSaved: (view: SavedViewRecord) => void;
  readonly onCancel?: () => void;
}

interface FilterRow {
  readonly key: string;
  readonly value: string;
}

const EMPTY_ROW: FilterRow = { key: '', value: '' };

function toRows(initial: SavedViewRecord | null | undefined): FilterRow[] {
  if (initial === undefined || initial === null) return [{ ...EMPTY_ROW }];
  const entries = Object.entries(initial.filters);
  if (entries.length === 0) return [{ ...EMPTY_ROW }];
  return entries.map(([key, value]) => ({ key, value: String(value) }));
}

/**
 * Parses one typed value: `true`/`false` stay boolean, a finite numeric text
 * stays a number, everything else is an exact string. The order matters: the
 * API applies strict equality, so the JSON type must match the column.
 */
export function parseFilterValueText(text: string): string | number | boolean {
  const trimmed = text.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed);
  return text;
}

/** Builds the filter bag, dropping incomplete rows (no key or no value). */
export function buildFilterBag(rows: readonly FilterRow[]): Record<string, string | number | boolean> {
  const bag: Record<string, string | number | boolean> = {};
  for (const row of rows) {
    if (row.key === '' || row.value.trim() === '') continue;
    bag[row.key] = parseFilterValueText(row.value);
  }
  return bag;
}

export function ViewForm({ entity, initial = null, onSaved, onCancel }: ViewFormProps) {
  const allowedKeys = SAVED_VIEW_FILTER_KEYS[entity];
  const [rows, setRows] = useState<FilterRow[]>(() => toRows(initial));
  const [shared, setShared] = useState(initial?.shared ?? false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  function setRow(index: number, next: Partial<FilterRow>): void {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...next } : row)));
  }

  async function handleSave(): Promise<void> {
    setFailure(null);
    setSaving(true);
    try {
      const filters = buildFilterBag(rows);
      const saved =
        initial === null
          ? await createSavedView({ entity, filters, shared })
          : await updateSavedView(initial.id, { entity, filters, shared });
      onSaved(saved);
    } catch (error) {
      setFailure(classifyApiError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Filtros de igualdad exacta para <code className="font-mono">{entity}</code>. Las filas sin
        clave o sin valor se ignoran; los valores se interpretan como booleano, número o texto en
        ese orden.
      </p>

      {rows.map((row, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <Select
            aria-label={`Clave del filtro ${index + 1}`}
            className="sm:max-w-55"
            value={row.key}
            onChange={(event) => setRow(index, { key: event.target.value })}
          >
            <option value="">Clave…</option>
            {allowedKeys.map((key: string) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </Select>
          <Input
            aria-label={`Valor del filtro ${index + 1}`}
            className="sm:max-w-xs"
            placeholder="Valor exacto"
            value={row.value}
            onChange={(event) => setRow(index, { value: event.target.value })}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={rows.length <= 1}
            onClick={() =>
              setRows((current) => current.filter((_, i) => i !== index))
            }
          >
            Quitar
          </Button>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={rows.length >= allowedKeys.length}
          onClick={() => setRows((current) => [...current, { ...EMPTY_ROW }])}
        >
          Agregar filtro
        </Button>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={shared}
            onChange={(event) => setShared(event.target.checked)}
          />
          Compartida con el tenant
        </label>
      </div>

      {failure !== null ? (
        <p className="text-xs text-danger" role="alert">
          {failure.message}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" disabled={saving} onClick={() => void handleSave()}>
          {saving ? 'Guardando…' : initial === null ? 'Guardar vista' : 'Actualizar vista'}
        </Button>
        {onCancel !== undefined ? (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancelar
          </Button>
        ) : null}
      </div>
    </div>
  );
}
