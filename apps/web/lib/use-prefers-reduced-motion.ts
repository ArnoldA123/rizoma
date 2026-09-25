'use client';

// `prefers-reduced-motion` as a hook.
//
// The decorative motion of the Salud screens (the magnetic primary CTA, the
// optimistic revert flash) is pointer- and state-driven JavaScript, so the CSS
// media query alone is not enough: the effect has to *not run* for a user who
// asked for reduced motion. The hook starts `false` and only reads the media
// query after mount, which keeps the server markup and the first client render
// identical (no hydration mismatch).
import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/** `true` when the user asked the system to reduce motion. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(QUERY);
    setReduced(media.matches);
    const onChange = (event: MediaQueryListEvent): void => setReduced(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
