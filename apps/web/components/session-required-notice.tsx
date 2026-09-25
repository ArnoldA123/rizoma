import Link from 'next/link';
import { Alert } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { IconLock } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

/**
 * Unauthenticated state — the difference between "I do not know who you are"
 * and "I know who you are and you may not". It carries the identity error code
 * and the correlation id exactly like a denial, plus the login affordance, and
 * it never echoes the raw token or claim contents.
 */
export interface SessionRequiredNoticeProps {
  readonly code: string;
  readonly reason: string;
  readonly message: string;
  readonly traceId: string;
}

export function SessionRequiredNotice({
  code,
  reason,
  message,
  traceId,
}: SessionRequiredNoticeProps) {
  return (
    <Alert
      variant="info"
      icon={<IconLock className="mt-0.5 h-4 w-4 text-muted-foreground" />}
      title="Sesión requerida"
    >
      <p>{message}</p>
      <dl className="tabular mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">code</dt>
        <dd className="font-mono">{code}</dd>
        <dt className="text-muted-foreground">reason</dt>
        <dd className="font-mono">{reason}</dd>
        <dt className="text-muted-foreground">traceId</dt>
        <dd className="font-mono break-all">{traceId}</dd>
      </dl>
      <p className="mt-3">
        Sin rol no hay decisión de acceso posible: la guarda del web resuelve la identidad y el
        alcance, y el API vuelve a decidir en cada llamada.
      </p>
      <div className="mt-3">
        <Link href="/login" className={cn(buttonVariants({ variant: 'primary', size: 'sm' }))}>
          Ir al inicio de sesión
        </Link>
      </div>
    </Alert>
  );
}
