import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Alert — inline notice. `denied` is the only variant that carries the danger
 * pair, so a refusal is never confused with an ordinary informational note.
 */
export const alertVariants = cva('flex gap-3 rounded-lg border px-4 py-3.5 text-sm', {
  variants: {
    variant: {
      info: 'border-border bg-secondary text-foreground',
      muted: 'border-border bg-transparent text-muted-foreground',
      denied: 'border-danger/40 bg-danger-tint text-foreground',
    },
  },
  defaultVariants: { variant: 'info' },
});

export type AlertProps = HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof alertVariants> & {
    readonly icon?: ReactNode;
    readonly title?: ReactNode;
  };

export function Alert({ className, variant, icon, title, children, ...props }: AlertProps) {
  return (
    <div role="note" className={cn(alertVariants({ variant }), className)} {...props}>
      {icon === undefined ? null : <div className="mt-px shrink-0">{icon}</div>}
      <div className="flex min-w-0 flex-col gap-1">
        {title === undefined ? null : <p className="font-semibold">{title}</p>}
        <div className="min-w-0 text-[0.8125rem] leading-6 [&_p]:text-muted-foreground">
          {children}
        </div>
      </div>
    </div>
  );
}
