import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * Button — the shadcn/ui shape (a `cva` variant table plus a `buttonVariants`
 * export), so the same class recipe can be applied to a `next/link` without a
 * second component.
 *
 * Palette use is deliberate: `primary` is the inverted surface pairing
 * (`--base-hover`/`--base-paper` at rest and on hover), `accent` is the one
 * place a skin colour reaches an interactive control, and `outline`/`ghost`
 * stay hairline-only so a screen never turns into a field of filled buttons.
 */
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary:
          'bg-primary text-primary-foreground border border-transparent hover:bg-hover hover:text-on-hover',
        accent:
          'bg-accent text-accent-foreground border border-transparent hover:brightness-[1.08]',
        outline: 'border border-border bg-transparent text-foreground hover:bg-secondary',
        ghost: 'border border-transparent bg-transparent text-muted-foreground hover:bg-secondary hover:text-foreground',
        danger: 'border border-danger/40 bg-danger-tint text-danger hover:bg-danger hover:text-background',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-9.5 px-4 text-sm',
        lg: 'h-11 px-6 text-sm',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'outline', size: 'md' },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type, ...props }: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
