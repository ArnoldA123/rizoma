'use client';

import { useState, type PointerEvent, type ReactNode } from 'react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';

/**
 * MagneticCta — the primary call to action, and the only magnetic element of the
 * app.
 *
 * The rule the design steer sets is *selective* premium behaviour: exactly one
 * control per screen pulls toward the pointer, and it is the one that submits
 * the screen's intent. A page full of magnetic buttons is noise; one is a
 * signal.
 *
 * Implementation constraints, all deliberate:
 *   - the pull is a `transform` on a wrapper (never on layout properties), so
 *     the button never reflows and the browser keeps it on the compositor;
 *   - the displacement is capped at a few pixels and scales with the pointer's
 *     distance from the centre, so the control still feels fixed;
 *   - pointer type is respected: `onPointerMove` ignores the effect entirely for
 *     a `touch` pointer, where there is no hover to track;
 *   - with `prefers-reduced-motion: reduce` the magnetic effect is not merely
 *     shortened, it is switched off (`transform: none`), which is the documented
 *     static fallback.
 */
export interface MagneticCtaProps extends ButtonProps {
  /** Maximum displacement in pixels; 4 keeps the pull felt but not playful. */
  readonly strength?: number;
  readonly children: ReactNode;
}

export function MagneticCta({
  strength = 4,
  className,
  children,
  ...props
}: MagneticCtaProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [offset, setOffset] = useState<{ readonly x: number; readonly y: number }>({
    x: 0,
    y: 0,
  });

  function handlePointerMove(event: PointerEvent<HTMLSpanElement>): void {
    if (reducedMotion || event.pointerType === 'touch') return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return;
    const dx = (event.clientX - (bounds.left + bounds.width / 2)) / (bounds.width / 2);
    const dy = (event.clientY - (bounds.top + bounds.height / 2)) / (bounds.height / 2);
    setOffset({
      x: Math.round(clamp(dx) * strength),
      y: Math.round(clamp(dy) * strength * 0.5),
    });
  }

  const transform = reducedMotion
    ? undefined
    : `translate3d(${offset.x}px, ${offset.y}px, 0)`;

  return (
    <span
      className="sd-magnetic"
      style={transform === undefined ? undefined : { transform }}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => setOffset({ x: 0, y: 0 })}
    >
      <Button variant="primary" className={className} {...props}>
        {children}
      </Button>
    </span>
  );
}

function clamp(value: number): number {
  return Math.max(-1, Math.min(1, value));
}
