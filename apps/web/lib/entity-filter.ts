/**
 * Pure helpers of the generic entity picker (sede, persona, turno de caja,
 * partida de presupuesto).
 *
 * Same precedent as `lib/salud-select.ts`: the API lists answer a bare array
 * capped at 200 rows, so the whole scope fits in the browser and the search
 * filters in the browser too. These functions are that rule in one place, next
 * to the component that renders them (`components/ui/entity-select.tsx`), so
 * the screens share one filter and the tests pin it without rendering React.
 *
 * The component receives ready-made `{id, label, sub?}` rows — each screen
 * builds the label in its own words (nombre de sede, nombre más correo,
 * apertura más estado) — and reports the pick as an id. The id travels as the
 * option value and never reaches the visible text: no UUID is shown.
 */
export interface EntityItem {
  readonly id: string;
  readonly label: string;
  readonly sub?: string;
}

/**
 * Browser-side filter of the selector scope: matches `label`, ignoring case,
 * surrounding blanks and diacritics (`jose` finds `José`). A blank query
 * returns the whole scope; `sub` never participates — the search answers
 * "¿cómo se llama?" and nothing else.
 */
function fold(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function filterEntityItems(
  items: readonly EntityItem[],
  query: string,
): EntityItem[] {
  const needle = fold(query);
  if (needle === '') return [...items];
  return items.filter((item) => fold(item.label).includes(needle));
}

/**
 * Resolves the selected id to its row, or `null` when nothing is selected or
 * the id left the scope. The `Select` itself is controlled by `value`; this
 * helper is the testable statement of "la selección viaja por id".
 */
export function entityItemById(
  items: readonly EntityItem[],
  id: string | null,
): EntityItem | null {
  if (id === null || id === '') return null;
  return items.find((item) => item.id === id) ?? null;
}

/** Visible text of one option: the label plus the secondary hint in one line. */
export function entityOptionText(item: EntityItem): string {
  return item.sub === undefined || item.sub === '' ? item.label : `${item.label} — ${item.sub}`;
}
