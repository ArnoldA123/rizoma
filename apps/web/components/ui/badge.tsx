import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** Badge — small status pill. `accent` is where a skin colour lands in a list. */
export const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[0.6875rem] font-medium tracking-[0.02em] whitespace-nowrap',
  {
    variants: {
      variant: {
        neutral: 'border-border bg-secondary text-muted-foreground',
        outline: 'border-border bg-transparent text-foreground',
        accent: 'border-transparent bg-accent text-accent-foreground',
        tinted: 'border-accent/30 bg-accent-tint text-accent',
        danger: 'border-danger/40 bg-danger-tint text-danger',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
