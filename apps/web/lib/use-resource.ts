'use client';

// Async resource hook for the Salud screens.
//
// Every panel needs the same five things: the data, a loading flag, a
// classified failure, a reload and an optimistic local replacement. Writing
// that five times is how the screens drift apart, so it lives here once.
//
// Two details matter for correctness:
//   - `key` is the identity of the resource (a patient id, a day, `patients`).
//     A change to it refetches; nothing else does, which is what keeps the
//     polling agenda from refetching on every render.
//   - the in-flight request is aborted when the key changes or the component
//     unmounts, and a stale answer is dropped, so a slow first request can
//     never overwrite the answer of the request that replaced it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { classifyApiError, type ApiFailure } from './salud-errors.ts';

/** What a screen gets back from {@link useResource}. */
export interface Resource<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly failure: ApiFailure | null;
  /** Refetches the resource, showing the loading state again. */
  readonly reload: () => void;
  /**
   * Refetches without touching the loading state: the rows stay on screen and
   * are replaced in place. This is what a poll needs — a board that blanks every
   * three minutes reads as broken.
   */
  readonly reloadSilently: () => void;
  /**
   * Replaces the data locally without a request. Used by the optimistic flows
   * (sign, close, pay, void) and by a create that can splice its own result in.
   */
  readonly setData: (next: T | ((current: T) => T)) => void;
  /** Second timestamp of the last successful load, for polling copy. */
  readonly loadedAt: number | null;
}

/** Optional behaviour of {@link useResource}. */
export interface ResourceOptions<T> {
  /**
   * Value to render before the first answer arrives — a cached board, not a
   * fabricated row. The first request still runs and replaces it.
   */
  readonly initialData?: T | null;
}

/**
 * Runs `load` whenever `key` changes. `load` receives the abort signal of its
 * own request; it is deliberately read from a ref so an inline arrow function
 * in the caller does not retrigger the effect.
 */
export function useResource<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
  options: ResourceOptions<T> = {},
): Resource<T> {
  const [data, setData] = useState<T | null>(options.initialData ?? null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [request, setRequest] = useState<{ nonce: number; silent: boolean }>({
    nonce: 0,
    silent: false,
  });

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  // Read during render on purpose: the caller recomputes it per render (a cache
  // lookup), and the effect below needs the value of the *current* key.
  const initialRef = useRef<T | null>(options.initialData ?? null);
  initialRef.current = options.initialData ?? null;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    if (!request.silent) {
      setLoading(true);
      setFailure(null);
      // Seeding on a key change is what makes a caller-side cache useful: the
      // rows of the key being read appear immediately instead of the previous
      // key's rows staying on screen under a new heading.
      if (initialRef.current !== null) setData(initialRef.current);
    }
    loadRef
      .current(controller.signal)
      .then((value) => {
        if (!active) return;
        setData(value);
        setLoadedAt(Date.now());
        setFailure(null);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        // A fetch AbortError is the expected outcome of a key change, not a
        // failure the user should see.
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setFailure(classifyApiError(error));
        setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [key, request]);

  const trigger = useCallback((silent: boolean) => {
    setRequest((current) => ({ nonce: current.nonce + 1, silent }));
  }, []);
  const reload = useCallback(() => trigger(false), [trigger]);
  const reloadSilently = useCallback(() => trigger(true), [trigger]);
  const update = useCallback((next: T | ((current: T) => T)) => {
    setData((current) => {
      if (current === null) return current;
      return typeof next === 'function' ? (next as (value: T) => T)(current) : next;
    });
  }, []);

  return { data, loading, failure, reload, reloadSilently, setData: update, loadedAt };
}
