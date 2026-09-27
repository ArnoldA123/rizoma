'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  CASH_TOTAL_METHODS,
  checkOptionalAmountField,
  checkUuidField,
  firstIssue,
  type CashSessionRecord,
  type FieldCheck,
} from '@rizoma/contracts';
import { Button } from '@/components/ui/button';
import { EntitySelector, type EntityItem } from '@/components/ui/entity-select';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldMessage, fieldStateProps } from '@/components/ui/field-feedback';
import { Input } from '@/components/ui/input';
import { FailurePanel } from '@/components/salud/states';
import { formatPen, formatSedeStamp } from '@/lib/format';
import { useSedeTimezone } from '@/lib/use-sede-timezone';
import { paymentMethodLabel } from '@/lib/labels';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { closeCashSession, listCashSessions, openCashSession } from '@/lib/salud-api';
import { listOrgNodes } from '@/lib/org-api';

/**
 * Cash shift of the caja screen: open, and close with an arqueo.
 *
 * Two facts about the API shape this panel:
 *
 *   - the shift is picked from the scope list with a browser-side search: the
 *     open form picks the sede, the close form picks the shift by opening date
 *     and status, and the id travels as the option value;
 *   - `POST /cash-sessions/close` takes the per-method totals as free JSONB, so
 *     the arqueo is declared here and stored as the cashier wrote it. The screen
 *     does not sum the day's payments into it: the declared count and the
 *     registered cobros are two different facts, and the audit keeps both.
 */
export interface CashSessionPanelProps {
  /** Shift opened or closed in this session, if any. */
  readonly session: CashSessionRecord | null;
  /** Sede prefill, from the last real row the screen read. */
  readonly defaultOrgNodeId: string;
  readonly onOpened: (session: CashSessionRecord) => void;
  readonly onClosed: (session: CashSessionRecord) => void;
  readonly className?: string;
}

export function CashSessionPanel({
  session,
  defaultOrgNodeId,
  onOpened,
  onClosed,
  className,
}: CashSessionPanelProps) {
  // The shift carries its sede; without one the screen prefill stands in
  // (P4-1c). Every stamp below reads in that zone, Lima fallback meanwhile.
  const sede = useSedeTimezone(session?.orgNodeId ?? defaultOrgNodeId);
  return (
    <Card className={className}>
      <CardHeader>
        <CardEyebrow>Turno de caja</CardEyebrow>
        <CardTitle as="h2">Apertura y arqueo</CardTitle>
        <CardDescription>
          Un comprobante no se puede emitir sin un turno abierto en la sede: el API resuelve el
          turno nuevo del día o responde <code className="font-mono text-xs">billing.cash_session_closed</code>{' '}
          cuando no hay ninguno.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        {session === null ? null : (
          <dl className="tabular grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-border bg-secondary px-4 py-3 text-xs">
            <dt className="text-muted-foreground">turno</dt>
            <dd>
              {formatSedeStamp(session.openedAt, sede.timezone)} · {session.status === 'open' ? 'abierto' : 'cerrado'}
            </dd>
            <dt className="text-muted-foreground">estado</dt>
            <dd>{session.status === 'open' ? 'abierto' : 'cerrado'}</dd>
            <dt className="text-muted-foreground">apertura</dt>
            <dd>{formatSedeStamp(session.openedAt, sede.timezone)}</dd>
            <dt className="text-muted-foreground">cierre</dt>
            <dd>{formatSedeStamp(session.closedAt, sede.timezone)}</dd>
            <dt className="text-muted-foreground">id</dt>
            <dd className="font-mono text-[0.6875rem] text-muted-foreground break-all">
              {session.id}
            </dd>
            {session.status === 'closed' ? (
              <>
                <dt className="text-muted-foreground">arqueo</dt>
                <dd>
                  {Object.entries(session.totals).length === 0
                    ? 'sin totales declarados'
                    : Object.entries(session.totals)
                        .map(([method, amount]) => `${paymentMethodLabel(method)} ${formatPen(Number(amount))}`)
                        .join(' · ')}
                </dd>
              </>
            ) : null}
          </dl>
        )}

        <div className="grid gap-5 lg:grid-cols-2">
          <OpenShiftForm
            defaultOrgNodeId={defaultOrgNodeId}
            onOpened={onOpened}
            disabled={session !== null && session.status === 'open'}
          />
          <CloseShiftForm session={session} onClosed={onClosed} sedeTimezone={sede.timezone} />
        </div>
      </CardContent>
    </Card>
  );
}

interface OpenShiftFormProps {
  readonly defaultOrgNodeId: string;
  readonly onOpened: (session: CashSessionRecord) => void;
  readonly disabled: boolean;
}

function OpenShiftForm({ defaultOrgNodeId, onOpened, disabled }: OpenShiftFormProps) {
  const [orgNodeId, setOrgNodeId] = useState(defaultOrgNodeId);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [sedeItems, setSedeItems] = useState<readonly EntityItem[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    listOrgNodes({ kind: 'sede' }, controller.signal)
      .then((rows) => {
        if (!active) return;
        setSedeItems(rows.map((row) => ({ id: row.id, label: row.name })));
      })
      .catch(() => {
        if (active) setSedeItems([]);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  const checks: Readonly<Record<string, FieldCheck>> = {
    orgNodeId: checkUuidField('orgNodeId', orgNodeId),
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setTouched(true);
    setFailure(null);
    if (firstIssue(checks) !== null) return;

    setSaving(true);
    try {
      const opened = await openCashSession({ orgNodeId: orgNodeId.trim() });
      onOpened(opened);
      setTouched(false);
    } catch (error) {
      setFailure(classifyApiError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={handleSubmit} noValidate>
      <div className="flex flex-col gap-1.5">
        <EntitySelector
          label="Sede del turno"
          items={sedeItems}
          value={orgNodeId === '' ? null : orgNodeId}
          onChange={(id) => {
            setOrgNodeId(id ?? '');
            setTouched(true);
          }}
          placeholder="Seleccionar sede…"
          searchPlaceholder="Buscar por nombre…"
          disabled={disabled}
        />
        <p className="text-xs text-muted-foreground">
          El valor predeterminado sale de la última fila real que leyó la pantalla.
        </p>
        <FieldMessage issue={checks.orgNodeId ?? null} touched={touched} validLabel="Sede aceptada." />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" size="sm" type="submit" disabled={saving || disabled}>
          {saving ? 'Abriendo…' : 'Abrir turno'}
        </Button>
        {disabled ? (
          <span className="text-xs text-muted-foreground">
            Ya hay un turno abierto en esta sesión. Ciérrelo para abrir otro.
          </span>
        ) : null}
      </div>

      {failure === null ? null : (
        <FailurePanel title="El turno no se abrió" failure={failure} />
      )}
    </form>
  );
}

interface CloseShiftFormProps {
  readonly session: CashSessionRecord | null;
  readonly onClosed: (session: CashSessionRecord) => void;
  /** Sede zone of the panel — the shift list reads in it. */
  readonly sedeTimezone: string;
}

function CloseShiftForm({ session, onClosed, sedeTimezone }: CloseShiftFormProps) {
  const [cashSessionId, setCashSessionId] = useState('');
  const [totals, setTotals] = useState<Readonly<Record<string, string>>>(() =>
    Object.fromEntries(CASH_TOTAL_METHODS.map((method) => [method, ''])),
  );
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [closed, setClosed] = useState<CashSessionRecord | null>(null);
  const [sessionItems, setSessionItems] = useState<readonly EntityItem[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    listCashSessions({}, controller.signal)
      .then((rows) => {
        if (!active) return;
        setSessionItems(
          rows.map((row) => ({
            id: row.id,
            label: `${formatSedeStamp(row.openedAt, sedeTimezone)} · ${row.status === 'open' ? 'abierto' : 'cerrado'}`,
            sub: row.openedByName ?? undefined,
          })),
        );
      })
      .catch(() => {
        if (active) setSessionItems([]);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [sedeTimezone]);

  const target = cashSessionId.trim() === '' ? (session?.id ?? '') : cashSessionId;
  const checks: Readonly<Record<string, FieldCheck>> = {
    cashSessionId: checkUuidField('cashSessionId', target),
    ...Object.fromEntries(
      CASH_TOTAL_METHODS.map((method) => [
        `totals.${method}`,
        checkOptionalAmountField(`totals.${method}`, totals[method] ?? ''),
      ]),
    ),
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setTouched(true);
    setFailure(null);
    if (firstIssue(checks) !== null) return;

    // Only the methods the cashier actually counted travel; an empty field is
    // an absence, not a declared zero.
    const declared: Record<string, number> = {};
    for (const method of CASH_TOTAL_METHODS) {
      const raw = (totals[method] ?? '').trim();
      if (raw !== '') declared[method] = Number(raw);
    }

    setSaving(true);
    try {
      const result = await closeCashSession({ cashSessionId: target.trim(), totals: declared });
      setClosed(result);
      onClosed(result);
      setTouched(false);
    } catch (error) {
      setFailure(classifyApiError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={handleSubmit} noValidate>
      <div className="flex flex-col gap-1.5">
        <EntitySelector
          label="Turno a cerrar"
          items={session?.id == null ? sessionItems : [
            { id: session.id, label: `${formatSedeStamp(session.openedAt, sedeTimezone)} · ${session.status === 'open' ? 'abierto' : 'cerrado'}`, sub: session.openedByName ?? undefined },
            ...sessionItems.filter((item) => item.id !== session.id),
          ]}
          value={cashSessionId === '' ? null : cashSessionId}
          onChange={(id) => {
            setCashSessionId(id ?? '');
            setTouched(true);
          }}
          placeholder="En blanco: turno de esta pantalla"
          searchPlaceholder="Buscar por fecha…"
        />
        <p className="text-xs text-muted-foreground">
          En blanco se cierra el turno que abrió esta pantalla. Para uno anterior, elíjalo de la
          lista del alcance.
        </p>
        <FieldMessage
          issue={checks.cashSessionId ?? null}
          touched={touched}
          validLabel={session?.id === target ? 'Turno de esta sesión.' : 'Turno indicado.'}
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-[0.8125rem] font-medium">Arqueo por método</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {CASH_TOTAL_METHODS.map((method) => (
            <div key={method} className="flex flex-col gap-1">
              <label htmlFor={`cash-total-${method}`} className="text-xs text-muted-foreground">
                {paymentMethodLabel(method)}
              </label>
              <Input
                id={`cash-total-${method}`}
                inputMode="decimal"
                placeholder="—"
                value={totals[method] ?? ''}
                onChange={(event) =>
                  setTotals((current) => ({ ...current, [method]: event.target.value }))
                }
                {...fieldStateProps(checks[`totals.${method}`] ?? null, touched)}
              />
              <FieldMessage issue={checks[`totals.${method}`] ?? null} touched={touched} />
            </div>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" type="submit" disabled={saving}>
          {saving ? 'Cerrando…' : 'Cerrar turno'}
        </Button>
        {closed === null ? null : (
          <span role="status" className="sd-rise text-xs text-muted-foreground">
            Turno del {formatSedeStamp(closed.openedAt, sedeTimezone)} cerrado el {formatSedeStamp(closed.closedAt, sedeTimezone)}.
          </span>
        )}
      </div>

      {failure === null ? null : (
        <FailurePanel title="El turno no se cerró" failure={failure} />
      )}
    </form>
  );
}
