import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';

/** Page header: one title, one sentence of intent, a few honest badges. */
export interface PageHeaderProps {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly badges?: readonly string[];
  readonly action?: ReactNode;
}

export function PageHeader({ eyebrow, title, description, badges = [], action }: PageHeaderProps) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
      <div className="flex max-w-2xl flex-col gap-2">
        <p className="text-[0.6875rem] font-medium tracking-[0.09em] text-muted-foreground uppercase">
          {eyebrow}
        </p>
        <h1 className="text-[1.375rem] leading-8 font-semibold tracking-[-0.017em]">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
        {badges.length === 0 ? null : (
          <div className="mt-1 flex flex-wrap gap-2">
            {badges.map((badge) => (
              <Badge key={badge} variant="outline">
                {badge}
              </Badge>
            ))}
          </div>
        )}
      </div>
      {action === undefined ? null : <div className="flex items-center gap-2">{action}</div>}
    </header>
  );
}
