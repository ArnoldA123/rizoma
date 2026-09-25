import type { ReactNode } from 'react';
import { Card, CardContent, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Scope note — a short, explicit statement of the rule a screen will obey.
 *
 * Used by the W1 stubs to record *why* a screen is partial: which role holds
 * which capability, and which term of the formal rule the API still enforces
 * during this stage. A stub that only says "próximamente" leaves the reviewer
 * guessing; this one is a checkable claim.
 */
export interface ScopeNoteProps {
  readonly eyebrow: string;
  readonly title: string;
  readonly children: ReactNode;
}

export function ScopeNote({ eyebrow, title, children }: ScopeNoteProps) {
  return (
    <Card>
      <CardHeader>
        <CardEyebrow>{eyebrow}</CardEyebrow>
        <CardTitle as="h2">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-muted-foreground">{children}</CardContent>
    </Card>
  );
}
