'use client';

import { cn } from '@/lib/utils';

/**
 * Toggle — the single control the consent matrix uses for a `SI`/`NO` decision.
 *
 * Why a toggle and not a checkbox: §2.6 is a *decision per recording type*, and
 * a switch that says "Sí/No" states the decision in the control itself, instead
 * of leaving the reader to infer "unchecked = NO" (which would be wrong for a
 * matrix where the negative is an explicit, auditable answer).
 *
 * Motion is deliberately small and compositor-only: the thumb travels with
 * `transform`, the track changes colour, nothing moves in layout. Under
 * `prefers-reduced-motion` the global rule collapses the duration, so the state
 * change is instant but the target position is identical (no jump in geometry).
 */
export interface ToggleProps {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly label: string;
  readonly hint?: string;
  readonly disabled?: boolean;
  /** Copy of the two states, in the order `[false, true]`. */
  readonly states?: readonly [string, string];
  readonly className?: string;
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
  states = ['No', 'Sí'],
  className,
}: ToggleProps) {
  return (
    <div className={cn('flex items-center justify-between gap-4', className)}>
      <div className="flex min-w-0 flex-col">
        <span className="text-[0.8125rem] font-medium">{label}</span>
        {hint === undefined ? null : (
          <span className="text-xs text-muted-foreground">{hint}</span>
        )}
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={`${label}: ${checked ? states[1] : states[0]}`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'flex shrink-0 items-center gap-2 rounded-full border px-1 py-1 transition-colors',
          checked ? 'border-accent/40 bg-accent-tint' : 'border-border bg-secondary',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'relative block h-4 w-8 rounded-full transition-colors',
            checked ? 'bg-accent' : 'bg-border',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 left-0.5 block h-3 w-3 rounded-full bg-card transition-transform duration-200 ease-out',
            )}
            style={{ transform: checked ? 'translate3d(16px, 0, 0)' : 'translate3d(0, 0, 0)' }}
          />
        </span>
        <span className="w-9 text-left text-[0.6875rem] font-medium">
          {checked ? states[1] : states[0]}
        </span>
      </button>
    </div>
  );
}
