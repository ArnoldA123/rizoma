'use client';

// Sede timezone hook for the P4-1c panels.
//
// Every panel below the agenda needs the same single fact: the IANA zone of
// its sede, resolved from the org tree with a Lima fallback. The matching rule
// lives in `lib/salud-time.ts#resolveSedeTimezone` (P4-1b); this hook is only
// the fetch around it, built on `useResource` so the panels share the
// abort-on-unmount and failure-classification behaviour instead of each writing
// its own effect.
//
// While the tree is loading (or when the read failed) the hook answers the
// Lima fallback with `loaded: false`, so a panel never blocks on an auxiliary
// read: the stamp renders in the fallback zone and settles into the sede zone
// on the next render.
import type { OrgNodeRecord } from '@rizoma/contracts';
import { listOrgNodes } from './org-api.ts';
import { resolveSedeTimezone } from './salud-time.ts';
import { useResource } from './use-resource.ts';

/** What a screen gets back from {@link useSedeTimezone}. */
export interface SedeTimezone {
  /** IANA zone of the sede, or the Lima fallback while loading or on failure. */
  readonly timezone: string;
  /** `true` once the org tree answered (success or classified failure). */
  readonly loaded: boolean;
}

/**
 * Resolves the zone of `orgNodeId` against the org tree. A missing id resolves
 * against the first node and an empty or failed tree reads as Lima — the same
 * fallback `resolveSedeTimezone` applies, so the hook never throws at render
 * time.
 */
export function useSedeTimezone(orgNodeId?: string | null): SedeTimezone {
  const nodes = useResource<OrgNodeRecord[]>('org-nodes:sede-timezone', (signal) =>
    listOrgNodes({}, signal),
  );
  return {
    timezone: resolveSedeTimezone(nodes.data ?? [], orgNodeId ?? null),
    loaded: !nodes.loading,
  };
}
