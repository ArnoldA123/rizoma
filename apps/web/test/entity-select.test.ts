// Entity filter tests — the client-side search and id-selection rules of the
// generic P2 picker (sede, persona, turno de caja, partida de presupuesto).
//
// The API lists answer the whole scope capped at 200 rows with no filter
// parameter, so the screens filter in the browser. These pure functions are
// that rule in one place (`lib/entity-filter.ts`); the component
// (`components/ui/entity-select.tsx`) only renders what they answer. If the
// search and the selection stop agreeing, these are the tests that fail first.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  entityItemById,
  entityOptionText,
  filterEntityItems,
  type EntityItem,
} from '../lib/entity-filter.ts';

const SEDE_NORTE = '11111111-1111-4111-8111-111111111111';
const SEDE_SUR = '22222222-2222-4222-8222-222222222222';
const PERSONA = '33333333-3333-4333-8333-333333333333';

function scope(): EntityItem[] {
  return [
    { id: SEDE_NORTE, label: 'Sede Norte', sub: 'Av. Principal 123' },
    { id: SEDE_SUR, label: 'Sede Sur', sub: 'Jr. Secundario 456' },
    { id: PERSONA, label: 'José García', sub: 'jose.garcia@example.com' },
  ];
}

test('filtrado: una búsqueda en blanco devuelve todo el alcance en copia nueva', () => {
  const items = scope();
  for (const query of ['', '   ']) {
    const visible = filterEntityItems(items, query);
    assert.deepEqual(visible, items);
    assert.notEqual(visible, items);
  }
  // The caller's scope is never mutated: the filter returns a new array.
  assert.equal(items.length, 3);
});

test('filtrado: ignora mayúsculas y espacios alrededor de la búsqueda', () => {
  const items = scope();
  assert.deepEqual(
    filterEntityItems(items, 'sede').map((row) => row.id),
    [SEDE_NORTE, SEDE_SUR],
  );
  assert.deepEqual(
    filterEntityItems(items, 'SEDE').map((row) => row.id),
    [SEDE_NORTE, SEDE_SUR],
  );
  assert.deepEqual(
    filterEntityItems(items, '  sur  ').map((row) => row.id),
    [SEDE_SUR],
  );
});

test('filtrado: la tilde exacta coincide sin importar las mayúsculas', () => {
  const items = scope();
  assert.deepEqual(
    filterEntityItems(items, 'josé').map((row) => row.id),
    [PERSONA],
  );
  assert.deepEqual(
    filterEntityItems(items, 'JOSÉ GARCÍA').map((row) => row.id),
    [PERSONA],
  );
  // Partial match answers "¿cómo se llama?" the same way: any substring works.
  assert.deepEqual(
    filterEntityItems(items, 'garc').map((row) => row.id),
    [PERSONA],
  );
});

test('filtrado: la búsqueda no exige tildes', () => {
  const items = scope();
  assert.deepEqual(
    filterEntityItems(items, 'jose').map((row) => row.id),
    [PERSONA],
  );
  assert.deepEqual(
    filterEntityItems(items, 'JOSE GARCIA').map((row) => row.id),
    [PERSONA],
  );
});

test('filtrado: el sub nunca participa — la búsqueda responde solo por el nombre', () => {
  const items = scope();
  // Both hints live only in `sub`: matching them must return nothing, so the
  // search never answers "¿cuál es su correo/dirección?".
  assert.deepEqual(filterEntityItems(items, 'principal'), []);
  assert.deepEqual(filterEntityItems(items, 'jose.garcia@example.com'), []);
  assert.deepEqual(filterEntityItems(items, 'secundario'), []);
});

test('selección: el id resuelve su fila y lo ausente resuelve nulo', () => {
  const items = scope();
  assert.equal(entityItemById(items, SEDE_NORTE)?.label, 'Sede Norte');
  assert.equal(entityItemById(items, PERSONA)?.label, 'José García');

  // "Sin selección" travels as `null` or `''`; an id that left the scope (a
  // deactivated sede, a stale link) resolves to `null` so the Select falls
  // back to its placeholder instead of showing a ghost row.
  assert.equal(entityItemById(items, null), null);
  assert.equal(entityItemById(items, ''), null);
  assert.equal(entityItemById(items, '99999999-9999-4999-8999-999999999999'), null);
  assert.equal(entityItemById([], SEDE_NORTE), null);
});

test('texto de opción: el nombre viaja solo y el sub va en la misma línea', () => {
  assert.equal(entityOptionText({ id: SEDE_NORTE, label: 'Sede Norte' }), 'Sede Norte');
  assert.equal(entityOptionText({ id: SEDE_NORTE, label: 'Sede Norte', sub: '' }), 'Sede Norte');
  assert.equal(
    entityOptionText({ id: SEDE_NORTE, label: 'Sede Norte', sub: 'Av. Principal 123' }),
    'Sede Norte — Av. Principal 123',
  );
  // The id never reaches the visible text: no UUID is shown.
  const text = entityOptionText(scope()[0]);
  assert.ok(!text.includes(SEDE_NORTE));
});
