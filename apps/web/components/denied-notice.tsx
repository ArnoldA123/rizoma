'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Alert } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { IconLock } from '@/components/ui/icons';
import { actionLabel, ROLE_LABELS } from '@/lib/labels';
import type { RoleCode } from '@/lib/access';
import { cn } from '@/lib/utils';

/**
 * Denied state — the UI half of the `access.denied` envelope.
 *
 * The visible body stays plain language (reason, motive, next step and who
 * to tell); the machine fields travel only inside the collapsed detail, so a
 * refusal never leaks codes or correlation ids at a glance. Copying the
 * detail is what lets an operator find the matching audit row.
 */
export interface DeniedNoticeProps {
  readonly reason: string;
  readonly traceId: string;
  /** Action the role needed, when the denial comes from a route rule. */
  readonly action?: string;
  /** Role that produced the denial, as the token reports it. */
  readonly role?: string | null;
  /** Envelope code, kept out of the visible body. */
  readonly code?: string;
  /** HTTP status the API would answer, kept out of the visible body. */
  readonly status?: number;
}

/** Collapsed technical detail with a copy affordance. */
function CopyDetail({ text }: { readonly text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      document.body.removeChild(area);
    }
    setCopied(true);
  }

  return (
    <details className="mt-3 text-xs">
      <summary className="cursor-pointer text-muted-foreground underline underline-offset-2">
        Copiar detalle
      </summary>
      <pre className="tabular mt-2 overflow-x-auto rounded-md border border-border bg-secondary p-2 font-mono break-all whitespace-pre-wrap">
        {text}
      </pre>
      <button
        type="button"
        onClick={() => void copy()}
        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-2')}
      >
        {copied ? 'Copiado' : 'Copiar'}
      </button>
    </details>
  );
}

export function DeniedNotice({
  reason,
  traceId,
  action,
  role,
  code = 'access.denied',
  status = 403,
}: DeniedNoticeProps) {
  const roleName = role == null ? undefined : ROLE_LABELS[role as RoleCode];
  const motive =
    roleName === undefined
      ? 'No tiene permiso para esta pantalla.'
      : `Su rol ${roleName} no permite ${action === undefined ? 'esta acción' : actionLabel(action).toLowerCase()}.`;
  const nextStep =
    roleName === undefined
      ? 'Vuelva al inicio y continúe con las pantallas habilitadas.'
      : 'Vuelva al inicio y continúe con las pantallas habilitadas para su rol.';
  const detail = `code: ${code}\nreason: ${reason}\ntraceId: ${traceId}\nstatus: ${status}`;

  return (
    <Alert
      variant="denied"
      icon={<IconLock className="mt-0.5 h-4 w-4 text-danger" />}
      title="Sin permiso para esta pantalla"
    >
      <p>{motive}</p>
      <p>{nextStep}</p>
      <p>Si necesita este acceso, avise a jefatura o a soporte.</p>
      <CopyDetail text={detail} />
      <div className="mt-3">
        <Link href="/" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
          Volver al inicio
        </Link>
      </div>
    </Alert>
  );
}
