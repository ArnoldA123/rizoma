import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Card — a hairline surface. `CardTone` keeps the accent to a 2px top rule or a
 * tinted background so a skin never saturates a whole panel.
 */
export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  readonly tone?: 'default' | 'tinted' | 'accent';
}

export function Card({ className, tone = 'default', ...props }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border',
        tone === 'default' && 'bg-card',
        tone === 'tinted' && 'bg-accent-tint',
        tone === 'accent' && 'bg-card border-t-2 border-t-accent',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1.5 px-5 pt-5 pb-3', className)} {...props} />;
}

export interface CardTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  readonly as?: 'h1' | 'h2' | 'h3' | 'h4';
}

export function CardTitle({ className, as: Tag = 'h3', ...props }: CardTitleProps) {
  return (
    <Tag
      className={cn('text-[0.9375rem] leading-6 font-semibold tracking-[-0.011em]', className)}
      {...props}
    />
  );
}

export function CardEyebrow({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <p
      className={cn(
        'text-[0.6875rem] font-medium tracking-[0.09em] text-muted-foreground uppercase',
        className,
      )}
    >
      {children}
    </p>
  );
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 pb-5 text-sm', className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-wrap items-center gap-2 border-t border-border px-5 py-3.5', className)}
      {...props}
    />
  );
}
