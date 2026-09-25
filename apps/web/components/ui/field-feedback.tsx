'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { DraftIssue } from '@rizoma/contracts';
import { draftIssueMessage } from '@/lib/labels';
import { cn } from '@/lib/utils';

/**
 * Field-level feedback for the live-validation forms.
 *
 * The behaviour this component exists for: validation runs while the user types
 * (the checks come from `@rizoma/contracts`), and the verdict *arrives* instead
 * of appearing. Three details make that true:
 *   - the line keeps a fixed height once the field was touched, so a message
 *     never pushes the rest of the form down while someone is typing;
 *   - the text fades and rises in (`sd-rise`), which reads as a response to the
 *     keystroke rather than a flash;
 *   - the success state is shown too, so the user learns the field is settled
 *     and stops second-guessing a value the API will accept.
 *
 * `aria-live="polite"` announces the verdict to a screen reader without
 * interrupting typing; the invalid state also sets `aria-invalid` on the input
 * through the caller's `inputProps` helper below.
 *
 * The announceable copy lives in a **stable** live region: the paragraph is
 * mounted once and only its text changes. A region that is inserted together
 * with its text is not announced by every screen reader, so a verdict that
 * arrived that way would be silent — the classic failure of a live region that
 * looks correct in the markup. The reserved `min-h-4` keeps the form geometry
 * (no layout jump while typing) and still lets a longer message wrap instead of
 * overlapping the next row.
 */
export interface FieldMessageProps {
  readonly issue: DraftIssue | null;
  /** Whether the field was touched (or the form was submitted once). */
  readonly touched: boolean;
  /** Label of the accepted state; omit to stay silent when the field is valid. */
  readonly validLabel?: string;
  readonly className?: string;
}

export function FieldMessage({ issue, touched, validLabel, className }: FieldMessageProps) {
  const invalid = issue !== null;
  const message = !touched
    ? ''
    : invalid
      ? draftIssueMessage(issue)
      : (validLabel ?? '');

  return (
    <p
      aria-live="polite"
      className={cn(
        'sd-rise min-h-4 text-xs',
        invalid ? 'text-danger' : 'text-muted-foreground',
        className,
      )}
    >
      {message}
    </p>
  );
}

/**
 * Field wrapper with a live verdict: label, control and {@link FieldMessage}.
 *
 * Promoted from the private copy the obras panels carried one per file (W4/W5):
 * a form row was being reassembled four times with the same three elements, and
 * the only thing that varied was the label. `hint` is the optional fourth line
 * that explains a rule the label cannot carry ("este campo es la sede del alta").
 */
export interface LiveFieldProps {
  readonly id: string;
  readonly label: string;
  readonly issue: DraftIssue | null;
  readonly touched: boolean;
  /** Rule the field follows, rendered under the control before the verdict. */
  readonly hint?: string;
  /** Verdict label of the accepted state; omit to stay silent when valid. */
  readonly validLabel?: string;
  readonly children: ReactNode;
  readonly className?: string;
}

export function LiveField({
  id,
  label,
  issue,
  touched,
  hint,
  validLabel,
  children,
  className,
}: LiveFieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[0.8125rem] font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
      <FieldMessage issue={issue} touched={touched} validLabel={validLabel} />
    </div>
  );
}

/** Attributes an input needs to agree with its {@link FieldMessage}. */
export function fieldStateProps(issue: DraftIssue | null, touched: boolean): {
  readonly 'aria-invalid'?: boolean;
} {
  return touched && issue !== null ? { 'aria-invalid': true } : {};
}

/**
 * Character counter that fades in with use.
 *
 * The point is the *gradual* arrival: at rest the counter is transparent and
 * weightless, past half the allowance it starts to appear, and it only turns
 * into a warning colour at the limit. A counter that snaps in at the limit is
 * the abrupt behaviour this component deliberately avoids.
 */
export interface CharCounterProps {
  readonly value: string;
  readonly max: number;
  readonly className?: string;
}

export function CharCounter({ value, max, className }: CharCounterProps) {
  const used = value.length;
  const ratio = Math.min(used / max, 1);
  const strength = Math.max(0, (ratio - 0.45) / 0.55);
  const atLimit = used >= max;
  const nearLimit = used > max * 0.8;

  return (
    <span
      aria-hidden
      className={cn(
        'tabular text-[0.6875rem] transition-opacity duration-300',
        atLimit ? 'text-danger' : nearLimit ? 'text-muted-foreground' : 'text-muted-foreground',
        className,
      )}
      style={{ opacity: Number(strength.toFixed(2)) }}
    >
      {used} / {max}
    </span>
  );
}

/**
 * Confirmation tick used by the create forms.
 *
 * It mounts only when a write succeeded and animates once (`sd-rise`), so the
 * "saved" signal is tied to a real event instead of a permanent badge. The
 * component clears itself after a few seconds to keep the panel honest about
 * what just happened.
 */
export function SavedPulse({ label, resetKey }: { readonly label: string; readonly resetKey: string }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [resetKey]);

  if (!visible) return null;
  return (
    <span
      role="status"
      className="sd-rise inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent-tint px-2.5 py-0.5 text-[0.6875rem] font-medium text-accent"
    >
      <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="m5 12.5 4 4 10-10" />
      </svg>
      {label}
    </span>
  );
}
