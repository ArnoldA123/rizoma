'use client';

import type { ReactNode } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { IconAlertTriangle, IconLock } from '@/components/ui/icons';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import type { ApiFailure } from '@/lib/salud-errors';

/**
 * The two states a Salud panel shows instead of rows: a classified failure and a
 * typed empty result.
 *
 * Both are deliberate about what they display. A failure shows the four facts the
 * contract allows (`code`, `reason`, `traceId`, and the envelope message) and
 * nothing else — no tenant data, no record body, no stack — because a refusal
 * must not become an information channel. An empty state says *why* it is empty,
 * which is the difference between "no hay pacientes" and "no pude leer la
 * lista": the second one is a failure, not an absence of data.
 */

/** Envelope fields, rendered as the `dl` every denial and failure shares. */
export function EnvelopeFields({ failure }: { readonly failure: ApiFailure }) {
  return (
    <dl className="tabular mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      <dt className="text-muted-foreground">code</dt>
      <dd className="font-mono break-all">{failure.code}</dd>
      <dt className="text-muted-foreground">reason</dt>
      <dd className="font-mono break-all">{failure.reason ?? '—'}</dd>
      <dt className="text-muted-foreground">traceId</dt>
      <dd className="font-mono break-all">{failure.traceId ?? '—'}</dd>
    </dl>
  );
}

export interface FailurePanelProps {
  /** Short heading of what could not be read or written. */
  readonly title: string;
  readonly failure: ApiFailure;
  /** Only offered for a read that can be retried by the user. */
  readonly onRetry?: () => void;
  readonly className?: string;
}

export function FailurePanel({ title, failure, onRetry, className }: FailurePanelProps) {
  const denied = failure.kind === 'denied';
  return (
    <Alert
      variant={denied ? 'denied' : 'info'}
      className={className}
      icon={
        denied ? (
          <IconLock className="mt-0.5 h-4 w-4 text-danger" />
        ) : (
          <IconAlertTriangle className="mt-0.5 h-4 w-4 text-muted-foreground" />
        )
      }
      title={title}
    >
      <p>{failure.message}</p>
      {failure.hint === '' ? null : <p className="mt-1">{failure.hint}</p>}
      <EnvelopeFields failure={failure} />
      {onRetry === undefined ? null : (
        <div className="mt-3">
          <Button variant="outline" size="sm" onClick={onRetry}>
            Reintentar
          </Button>
        </div>
      )}
    </Alert>
  );
}

export interface EmptyStateProps {
  readonly eyebrow?: string;
  readonly title: string;
  readonly description: string;
  /** Actions the user can take from an empty screen (usually "registrar"). */
  readonly children?: ReactNode;
  readonly className?: string;
}

/** The typed empty result: an absence of rows, explained. */
export function EmptyState({ eyebrow, title, description, children, className }: EmptyStateProps) {
  return (
    <Card className={className}>
      <CardHeader>
        {eyebrow === undefined ? null : <CardEyebrow>{eyebrow}</CardEyebrow>}
        <CardTitle as="h3">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {children === undefined ? null : <CardContent>{children}</CardContent>}
    </Card>
  );
}

/** Inline announcement of what a write just produced, or that it failed. */
export function WriteResult({
  failure,
  success,
  className,
}: {
  readonly failure: ApiFailure | null;
  readonly success: string | null;
  readonly className?: string;
}) {
  if (failure !== null) {
    return <FailurePanel className={className} title="La operación no se aplicó" failure={failure} />;
  }
  if (success === null) return null;
  return (
    <p
      role="status"
      className={`sd-rise mt-3 rounded-md border border-accent/30 bg-accent-tint px-3 py-2 text-[0.8125rem] text-accent ${className ?? ''}`}
    >
      {success}
    </p>
  );
}
