'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  entityItemById,
  entityOptionText,
  filterEntityItems,
  type EntityItem,
} from '@/lib/entity-filter';

export type { EntityItem } from '@/lib/entity-filter';

/**
 * Generic entity picker for the P2 selectors (sede, persona, turno de caja,
 * partida de presupuesto).
 *
 * The scope is deliberately short: the API lists answer a bare array capped at
 * 200 rows, so the whole scope fits in the browser and the search filters in
 * the browser too. The component receives ready-made `{id, label, sub?}` rows
 * — each screen builds the label in its own words (nombre de sede, nombre más
 * correo, apertura más estado) — and reports the pick as an id. The id travels
 * as the option value and never reaches the visible text: no UUID is shown.
 */
export interface EntitySelectorProps {
  readonly label: string;
  readonly items: readonly EntityItem[];
  /** Selected id, or `null` / `''` for "sin selección". */
  readonly value: string | null;
  readonly onChange: (id: string | null) => void;
  readonly placeholder?: string;
  /** Search field placeholder. Defaults to «Buscar…». */
  readonly searchPlaceholder?: string;
  /** Text shown when the search matches nothing. */
  readonly emptyText?: string;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function EntitySelector({
  label,
  items,
  value,
  onChange,
  placeholder = 'Seleccionar…',
  searchPlaceholder = 'Buscar…',
  emptyText = 'Sin resultados para esa búsqueda.',
  disabled = false,
  className,
}: EntitySelectorProps) {
  const [search, setSearch] = useState('');
  const visible = filterEntityItems(items, search);
  const selected = entityItemById(items, value);

  return (
    <div className={className}>
      <label className="mb-1.5 block text-[0.8125rem] font-medium text-foreground">
        {label}
      </label>
      <Input
        type="search"
        aria-label={`Buscar en ${label}`}
        placeholder={searchPlaceholder}
        value={search}
        disabled={disabled}
        onChange={(event) => setSearch(event.target.value)}
      />
      <Select
        aria-label={label}
        className="mt-1.5"
        value={selected === null ? '' : selected.id}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next === '' ? null : next);
        }}
      >
        <option value="">{placeholder}</option>
        {visible.map((item) => (
          <option key={item.id} value={item.id}>
            {entityOptionText(item)}
          </option>
        ))}
      </Select>
      {visible.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">{emptyText}</p>
      ) : null}
    </div>
  );
}
