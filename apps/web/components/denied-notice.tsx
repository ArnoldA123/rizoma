import Link from 'next/link';
import { Alert } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { IconLock } from '@/components/ui/icons';
import { actionLabel, roleLabel } from '@/lib/labels';
import { cn } from '@/lib/utils';

/**
 * Denied state — the UI half of the `access.denied` envelope.
 *
 * It renders the same three fields the API returns (`code`, `reason`,
 * `traceId`) and nothing else: no tenant data, no record content, no stack. A
 * refusal must not become an information leak, and the correlation id is what
 * lets an operator find the matching `access.denied` audit row.
 */
export interface DeniedNoticeProps {
  readonly reason: string;
  readonly traceId: string;
  /** Action the role needed, when the denial comes from a route rule. */
  readonly action?: string;
  /** Role that produced the denial, as the token reports it. */
  readonly role?: string | null;
}

export function DeniedNotice({ reason, traceId, action, role }: DeniedNoticeProps) {
  return (
    <Alert
      variant="denied"
      icon={<IconLock className="mt-0.5 h-4 w-4 text-danger" />}
      title="Acceso denegado"
    >
      <p>
        {role === null || role === undefined
          ? 'No hay una identidad con rol resuelta para esta pantalla.'
          : `El rol ${roleLabel(role)} no permite ${action === undefined ? 'esta acción' : actionLabel(action).toLowerCase()}.`}
      </p>
      <dl className="tabular mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">code</dt>
        <dd className="font-mono text-danger">access.denied</dd>
        <dt className="text-muted-foreground">reason</dt>
        <dd className="font-mono">{reason}</dd>
        <dt className="text-muted-foreground">traceId</dt>
        <dd className="font-mono break-all">{traceId}</dd>
      </dl>
      <p className="mt-3">
        El API mantiene la decisión final: la misma solicitud respondería 403 con este mismo motivo
        y este mismo identificador de traza.
      </p>
      <div className="mt-3">
        <Link href="/" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
          Volver al inicio
        </Link>
      </div>
    </Alert>
  );
}
