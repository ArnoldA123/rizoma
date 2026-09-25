import type { SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * Select — the native control, styled to match {@link Input}.
 *
 * Why native and not a listbox: the two selects of W2 (document type, episode of
 * the patient) are short, static catalogs, and the native control inherits the
 * platform's keyboard, touch and screen-reader behaviour for free. A custom
 * listbox would be the larger risk here, not the smaller one.
 */
export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'h-9.5 w-full rounded-md border border-input bg-card px-2.5 text-sm text-foreground',
        'transition-colors hover:border-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}
