import type { CSSProperties, HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * Skeletons for the Salud screens.
 *
 * A skeleton here is not a grey box: it is the *shape of the row that is
 * coming*, so the layout does not jump when the data arrives — same height, same
 * column rhythm, same badge slot. The shimmer is a directional sweep
 * (`transform` only, defined in `app/salud/salud.css`) and there is no spinner
 * in this vertical: a spinner says "something is happening", a shaped skeleton
 * says what is about to appear.
 *
 * Usage: compose the real row with {@link Skeleton} bars. `aria-hidden` on
 * every piece keeps the placeholders out of the accessibility tree while the
 * panel announces its loading state once, in text.
 */
export interface SkeletonProps extends HTMLAttributes<HTMLSpanElement> {
  /** Stagger of the sweep, in milliseconds, so a list does not pulse in unison. */
  readonly delay?: number;
}

/** One shimmering block. Size and radius come from the caller's classes. */
export function Skeleton({ className, delay, style, ...props }: SkeletonProps) {
  const merged: CSSProperties =
    delay === undefined
      ? (style ?? {})
      : ({ ...style, '--sd-shimmer-delay': `${delay}ms` } as CSSProperties);
  return (
    <span
      aria-hidden
      className={cn('sd-shimmer block rounded-sm bg-secondary', className)}
      style={merged}
      {...props}
    />
  );
}

/** Badge-shaped placeholder, matching the status pills of the real rows. */
export function SkeletonBadge({ className, ...props }: SkeletonProps) {
  return <Skeleton className={cn('h-5 w-20 rounded-full', className)} {...props} />;
}

/**
 * Placeholder of the one-row list (`patient`, `appointment`, `episode`): a
 * leading block for the identifier column, two lines for the description and a
 * trailing badge. Repeating it is what makes the loading state read as "the
 * list is loading" rather than "the screen is broken".
 */
export function SkeletonRow({ delay = 0, className }: { readonly delay?: number; readonly className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        'flex items-center justify-between gap-4 border-b border-border px-1 py-3.5 last:border-b-0',
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <Skeleton className={cn('h-3.5 w-40')} delay={delay} />
        <Skeleton className={cn('h-2.5 w-56')} delay={delay + 60} />
      </div>
      <SkeletonBadge delay={delay + 120} />
    </div>
  );
}

/** `rows` copies of {@link SkeletonRow}, staggered by 90 ms each. */
export function SkeletonRows({ rows, className }: { readonly rows: number; readonly className?: string }) {
  return (
    <div className={className}>
      {Array.from({ length: rows }, (_, index) => (
        <SkeletonRow key={index} delay={index * 90} />
      ))}
    </div>
  );
}
