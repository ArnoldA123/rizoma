// `useSedeTimezone` contract — the P4-1c hook around `resolveSedeTimezone`.
//
// A hook with an async fetch cannot be observed past its first render without
// a DOM renderer (the web has none: `node --test` only), so these tests pin
// what the first render guarantees through `react-dom/server`, where effects
// never run: the Lima fallback and `loaded: false`, with or without a sede id.
// The id-matching rule itself is already covered in `salud-select.test.ts`
// against `resolveSedeTimezone`, the function the hook delegates to once the
// tree answers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { SEDE_FALLBACK_TIMEZONE } from '../lib/salud-time.ts';
import { useSedeTimezone, type SedeTimezone } from '../lib/use-sede-timezone.ts';

function readHook(orgNodeId?: string | null): SedeTimezone {
  let seen: SedeTimezone | null = null;
  function Probe(): React.ReactNode {
    seen = useSedeTimezone(orgNodeId);
    return null;
  }
  renderToString(React.createElement(Probe));
  if (seen === null) throw new Error('the probe never rendered the hook');
  return seen;
}

test('answers the Lima fallback unloaded when no sede id is given', () => {
  const seen = readHook();
  assert.equal(seen.timezone, SEDE_FALLBACK_TIMEZONE);
  assert.equal(seen.timezone, 'America/Lima');
  assert.equal(seen.loaded, false);
});

test('answers the Lima fallback unloaded while the tree has not answered yet', () => {
  const seen = readHook('44444444-4444-4444-8444-444444444444');
  assert.equal(seen.timezone, SEDE_FALLBACK_TIMEZONE);
  assert.equal(seen.loaded, false);
});
