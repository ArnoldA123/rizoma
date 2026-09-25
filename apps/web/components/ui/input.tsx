import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** Text field with the hairline treatment and the app focus ring. */
export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-9.5 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground',
        'placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60',
        'transition-colors hover:border-muted-foreground/50',
        className,
      )}
      {...props}
    />
  );
}

export interface FieldProps {
  readonly label: string;
  readonly hint?: string;
  readonly htmlFor?: string;
}

/** Label + hint wrapper, so a form row is one block instead of three. */
export function Field({ label, hint, htmlFor }: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={htmlFor}
        className="text-[0.8125rem] font-medium text-foreground"
      >
        {label}
      </label>
      {hint === undefined ? null : (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
