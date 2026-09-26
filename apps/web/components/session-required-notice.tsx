'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Alert } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { IconLock } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

/**
 * Unauthenticated state — the difference between "I do not know who you are"
 * and "I know who you are and you may not".
 *
 * The visible body stays plain language (motive, next step and who to tell);
 * the machine fields travel only inside the collapsed detail. It never echoes
 * the raw token or claim contents.
 */
export interface SessionRequiredNoticeProps {
  readonly code: string;
  readonly reason: string;
  readonly message: string;
  readonly traceId: string;
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

export function SessionRequiredNotice({
  code,
  reason,
  traceId,
  status = 401,
}: SessionRequiredNoticeProps) {
  // `message` stays accepted so existing callers keep compiling, but the
  // visible body uses the fixed plain-language lines above.
  const detail = `code: ${code}\nreason: ${reason}\ntraceId: ${traceId}\nstatus: ${status}`;

  return (
    <Alert
      variant="info"
      icon={<IconLock className="mt-0.5 h-4 w-4 text-muted-foreground" />}
      title="Entre para continuar"
    >
      <p>No encontramos su sesión, así que todavía no sabemos quién es usted.</p>
      <p>Entre con su cuenta para continuar.</p>
      <p>Si el problema sigue, avise a recepción o a soporte.</p>
      <CopyDetail text={detail} />
      <div className="mt-3">
        <Link href="/login" className={cn(buttonVariants({ variant: 'primary', size: 'sm' }))}>
          Entre aquí
        </Link>
      </div>
    </Alert>
  );
}
