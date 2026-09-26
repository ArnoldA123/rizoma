'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  ASSET_CODE_MAX,
  ASSET_KIND_MAX,
  ASSET_KIND_SUGGESTIONS,
  ASSET_READING_KIND_HOROMETER,
  ASSET_READING_KIND_SUGGESTIONS,
  ASSET_SERIAL_MAX,
  assetCanBeAssigned,
  assetCanBeRead,
  checkNumberField,
  checkRequiredText,
  checkUuidField,
  firstIssue,
  type AssetRecord,
  type FieldCheck,
} from '@rizoma/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { LiveField, FieldMessage } from '@/components/ui/field-feedback';
import { EntitySelector, type EntityItem } from '@/components/ui/entity-select';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, FailurePanel, WriteResult } from '@/components/ui/states';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { formatUtcStamp } from '@/lib/format';
import { assetStatusLabel, assetStatusVariant } from '@/lib/labels';
import {
  addAssetReading,
  assignAsset,
  listAssets,
  registerAsset,
  retireAsset,
  setAssetMaintenance,
} from '@/lib/obras-api';
import { listOrgNodes } from '@/lib/org-api';
import { useResource } from '@/lib/use-resource';

/**
 * Equipos: registrar una unidad, asignarla a esta obra, enviarla a mantenimiento,
 * retirarla y anotarle una lectura manual (horómetro).
 *
 * Three facts of the service shape this panel, and each one is rendered instead
 * of assumed:
 *
 *   1. **The catalogue is a site plan, not a site row.** `POST /v1/obras/assets`
 *      resolves `site.write` at the org node the body names, so the alta is
 *      offered to gerencia only and the sede field stays editable.
 *   2. **Only an `available` unit can be assigned** and a retired unit is never
 *      readable again. Both preconditions live in `@rizoma/contracts`
 *      (`assetCanBeAssigned`, `assetCanBeRead`), so the row after a write states
 *      which transitions remain open instead of leaving the operator to guess.
 *   3. **A reading is a field write.** It resolves `attendance.mark` plus an
 *      active assignment to the unit's *current* site — with the documented
 *      exemption of the org-scoped managers (`gerente`, `jefe_obra`), whose
 *      subtree already covers the site. That is why the action is offered under
 *      `canMark` and not under `site.write`.
 *
 * The table reads the scoped list (`GET /v1/obras/assets`, capped at 200
 * rows). The target field is shared with the obra board and with the table
 * itself: choosing a row fills the same UUID the transitions operate on, so
 * the board pick stays as a shortcut rather than the only source of ids.
 *
 * The primary control is a plain `Button variant="primary"` on purpose: the
 * design steer allows one magnetic CTA per screen, and on the ficha that one
 * belongs to the staff panel (W4).
 */
export interface AssetsPanelProps {
  readonly siteId: string;
  /** Sede the alta defaults to: the site's own org node, still editable. */
  readonly defaultOrgNodeId: string;
  /** `site.write` — register, maintenance and retire. */
  readonly canWrite: boolean;
  /** `assignment.write` — assign the unit to this site. */
  readonly canAssign: boolean;
  /** `attendance.mark` — append a manual reading (still needs the site key). */
  readonly canMark: boolean;
  /** Target unit shared with the obra board; `''` means "none picked yet". */
  readonly assetId: string;
  readonly onAssetIdChange: (assetId: string) => void;
  readonly className?: string;
}

interface RegisterDraft {
  orgNodeId: string;
  code: string;
  kind: string;
  serial: string;
}

interface ReadingDraft {
  kind: string;
  value: string;
}

export function AssetsPanel({
  siteId,
  defaultOrgNodeId,
  canWrite,
  canAssign,
  canMark,
  assetId,
  onAssetIdChange,
  className,
}: AssetsPanelProps) {
  const [register, setRegister] = useState<RegisterDraft>({
    orgNodeId: defaultOrgNodeId,
    code: '',
    kind: '',
    serial: '',
  });
  const [reading, setReading] = useState<ReadingDraft>({
    kind: ASSET_READING_KIND_HOROMETER,
    value: '',
  });
  const [touched, setTouched] = useState<Readonly<Record<string, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  /** Last unit this panel wrote, so the confirmation can state its open transitions. */
  const [lastAsset, setLastAsset] = useState<AssetRecord | null>(null);
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

  /** Scoped catalogue: units inside the membership subtree, capped at 200. */
  const catalogue = useResource<AssetRecord[]>('obras-assets', (signal) => listAssets(signal));
  /** Scope options of the target field: catalogue codes with kind and serial. */
  const assetOptions: readonly EntityItem[] = useMemo(
    () =>
      (catalogue.data ?? []).map((row) => ({
        id: row.id,
        label: row.code,
        sub: `${row.kind} · serie ${row.serial}`,
      })),
    [catalogue.data],
  );
  const rows = useMemo(() => {
    const all = catalogue.data ?? [];
    return [...all].sort((a, b) => {
      const aHere = a.currentSiteId === siteId ? 0 : 1;
      const bHere = b.currentSiteId === siteId ? 0 : 1;
      if (aHere !== bHere) return aHere - bHere;
      return a.code.localeCompare(b.code);
    });
  }, [catalogue.data, siteId]);

  const registerChecks: Readonly<Record<string, FieldCheck>> = useMemo(
    () => ({
      orgNodeId: checkUuidField('orgNodeId', register.orgNodeId),
      code: checkRequiredText('code', register.code, ASSET_CODE_MAX),
      kind: checkRequiredText('kind', register.kind, ASSET_KIND_MAX),
      serial: checkRequiredText('serial', register.serial, ASSET_SERIAL_MAX),
    }),
    [register],
  );
  const targetIssue = checkUuidField('assetId', assetId);
  const valueIssue = reading.value.trim() === '' ? null : checkNumberField('value', reading.value);

  const show = (field: string): boolean => touched[field] === true || submitted;

  function touch(field: string): void {
    setTouched((current) => ({ ...current, [field]: true }));
  }

  function start(): void {
    setFailure(null);
    setSuccess(null);
  }

  /** One state transition on the target unit: `assign`/`maintenance`/`retire`. */
  async function handleTransition(
    operation: () => Promise<AssetRecord>,
    describe: (asset: AssetRecord) => string,
  ): Promise<void> {
    if (targetIssue !== null) {
      setSubmitted(true);
      return;
    }
    start();
    setSaving(true);
    try {
      const asset = await operation();
      setLastAsset(asset);
      catalogue.reloadSilently();
      setSuccess(describe(asset));
    } catch (error) {
      setFailure(classifyApiError(error));
    } finally {
      setSaving(false);
    }
  }

  async function handleRegister(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitted(true);
    if (firstIssue(registerChecks) !== null) return;
    start();
    setSaving(true);
    try {
      const asset = await registerAsset({
        orgNodeId: register.orgNodeId.trim(),
        code: register.code.trim(),
        kind: register.kind.trim(),
        serial: register.serial.trim(),
      });
      setLastAsset(asset);
      catalogue.reloadSilently();
      onAssetIdChange(asset.id);
      setRegister((current) => ({ ...current, code: '', kind: '', serial: '' }));
      setTouched({});
      setSubmitted(false);
      setSuccess(
        `Unidad ${asset.code} registrada en estado «${assetStatusLabel(asset.status)}» bajo la sede ${sedeItems.find((item) => item.id === asset.orgNodeId)?.label ?? 'elegida'}. El código es único en el tenant: repetirlo responde obra.duplicate.`,
      );
    } catch (error) {
      setFailure(classifyApiError(error));
    } finally {
      setSaving(false);
    }
  }

  async function handleReading(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitted(true);
    if (targetIssue !== null || firstIssue({ value: checkNumberField('value', reading.value) }) !== null) {
      return;
    }
    start();
    setSaving(true);
    try {
      const record = await addAssetReading(assetId.trim(), {
        kind: reading.kind.trim() === '' ? ASSET_READING_KIND_HOROMETER : reading.kind.trim(),
        value: Number(reading.value.trim()),
      });
      setSuccess(
        `Lectura ${record.kind} = ${record.value} anotada el ${formatUtcStamp(record.at)}. Las lecturas son de solo inserción: no se editan ni se borran, y una unidad retirada ya no se lee.`,
      );
      setReading((current) => ({ ...current, value: '' }));
      setTouched({});
      setSubmitted(false);
    } catch (error) {
      setFailure(classifyApiError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className={className} id="equipos-obra">
      <CardHeader>
        <CardEyebrow>Equipos</CardEyebrow>
        <CardTitle as="h2">Unidad de equipo</CardTitle>
        <CardDescription>
          Registrar, asignar, enviar a mantenimiento, retirar y anotar lecturas manuales de horómetro.
          La tabla lista los equipos del alcance de su organización (máximo 200 filas): elegir una
          fila llena la unidad objetivo, igual que elegirla en el tablero de la obra.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[0.8125rem] font-medium">Equipos del alcance</span>
          <span className="tabular ml-auto text-xs text-muted-foreground">
            {catalogue.loading ? 'leyendo…' : `${rows.length} unidades`}
          </span>
          <Button variant="ghost" size="sm" onClick={catalogue.reload} disabled={catalogue.loading}>
            Actualizar
          </Button>
        </div>

        {catalogue.loading ? <AssetsSkeleton /> : null}

        {!catalogue.loading && catalogue.failure !== null ? (
          <FailurePanel
            title="No se pudo leer los equipos del alcance"
            failure={catalogue.failure}
            onRetry={catalogue.reload}
          />
        ) : null}

        {!catalogue.loading && catalogue.failure === null && rows.length === 0 ? (
          <EmptyState
            eyebrow="Sin equipos"
            title="No hay unidades en su alcance"
            description="El API respondió con una lista válida y vacía. La primera unidad se registra con el formulario de abajo; el código es único en el tenant."
          />
        ) : null}

        {!catalogue.loading && catalogue.failure === null && rows.length > 0 ? (
          <ul className="flex flex-col">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={assetStatusVariant(row.status)}>
                      {assetStatusLabel(row.status)}
                    </Badge>
                    <span className="tabular text-[0.8125rem] font-medium">{row.code}</span>
                    <span className="text-xs text-muted-foreground">{row.kind}</span>
                    {row.currentSiteId === siteId ? (
                      <Badge variant="outline">esta obra</Badge>
                    ) : null}
                  </div>
                  <span className="tabular font-mono text-[0.6875rem] text-muted-foreground">
                    unidad {row.id} · serie {row.serial}
                    {row.currentSiteId === null ? '' : ` · obra ${row.currentSiteId}`}
                  </span>
                </div>
                <Button
                  variant={assetId === row.id ? 'primary' : 'outline'}
                  size="sm"
                  disabled={assetId === row.id}
                  onClick={() => {
                    onAssetIdChange(row.id);
                    setSuccess(null);
                  }}
                >
                  {assetId === row.id ? 'Elegida' : 'Elegir'}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        {canWrite ? (
          <form className="flex flex-col gap-4" onSubmit={handleRegister} noValidate>
            <p className="text-xs text-muted-foreground">
              El alta exige <code className="font-mono">site.write</code> en el nodo destinatario; en
              la matriz de la demo solo gerencia lo tiene.
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="flex flex-col gap-1.5">
                <EntitySelector
                  label="Sede"
                  items={sedeItems}
                  value={register.orgNodeId === '' ? null : register.orgNodeId}
                  onChange={(id) => {
                    setRegister((current) => ({ ...current, orgNodeId: id ?? '' }));
                    touch('orgNodeId');
                  }}
                  placeholder="Seleccionar sede…"
                  searchPlaceholder="Buscar por nombre…"
                />
                <FieldMessage issue={registerChecks.orgNodeId ?? null} touched={show('orgNodeId')} validLabel="Dato aceptado." />
                <p className="text-xs text-muted-foreground">Sede del catálogo de equipos.</p>
              </div>
              <LiveField
                id="asset-code"
                label="Código"
                issue={registerChecks.code ?? null}
                touched={show('code')}
                hint="Único dentro del tenant."
              >
                <Input
                  id="asset-code"
                  maxLength={ASSET_CODE_MAX}
                  placeholder="EX-01"
                  value={register.code}
                  onChange={(event) => setRegister((current) => ({ ...current, code: event.target.value }))}
                  onBlur={() => touch('code')}
                />
              </LiveField>
              <LiveField id="asset-kind" label="Tipo" issue={registerChecks.kind ?? null} touched={show('kind')}>
                <Input
                  id="asset-kind"
                  list="asset-kind-suggestions"
                  autoComplete="off"
                  maxLength={ASSET_KIND_MAX}
                  placeholder="maquinaria"
                  value={register.kind}
                  onChange={(event) => setRegister((current) => ({ ...current, kind: event.target.value }))}
                  onBlur={() => touch('kind')}
                />
              </LiveField>
              <LiveField id="asset-serial" label="Serie" issue={registerChecks.serial ?? null} touched={show('serial')}>
                <Input
                  id="asset-serial"
                  maxLength={ASSET_SERIAL_MAX}
                  placeholder="SN-0001"
                  value={register.serial}
                  onChange={(event) => setRegister((current) => ({ ...current, serial: event.target.value }))}
                  onBlur={() => touch('serial')}
                />
              </LiveField>
            </div>
            <datalist id="asset-kind-suggestions">
              {ASSET_KIND_SUGGESTIONS.map((kind) => (
                <option key={kind} value={kind} />
              ))}
            </datalist>
            <div>
              <Button variant="primary" size="sm" type="submit" disabled={saving}>
                {saving ? 'Registrando…' : 'Registrar unidad'}
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              Su rol no puede dar de alta equipos: esa opción no se ofrece. Si necesita este
              acceso, avise a jefatura o a soporte.
            </p>
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground underline underline-offset-2">
                Copiar detalle
              </summary>
              <pre className="tabular mt-2 overflow-x-auto rounded-md border border-border bg-secondary p-2 font-mono break-all whitespace-pre-wrap">
                {`code: obra.scope_denied\nstatus: 403\naction: site.write`}
              </pre>
            </details>
          </div>
        )}

        <div className="flex flex-col gap-4 border-t border-border pt-4">
          <div className="flex flex-col gap-1.5">
            <EntitySelector
              label="Unidad objetivo"
              items={assetOptions}
              value={assetId === '' ? null : assetId}
              onChange={(id) => {
                onAssetIdChange(id ?? '');
                touch('assetId');
                setSuccess(null);
              }}
              placeholder="Seleccionar equipo…"
              searchPlaceholder="Buscar por código…"
            />
            <FieldMessage issue={targetIssue} touched={show('assetId') || assetId !== ''} validLabel="Dato aceptado." />
            <p className="text-xs text-muted-foreground">Se completa al elegir una fila de la tabla o un equipo en el tablero de la obra.</p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {canAssign ? (
              <Button
                variant="outline"
                size="sm"
                disabled={saving || targetIssue !== null}
                onClick={() =>
                  void handleTransition(
                    () => assignAsset(assetId.trim(), { siteId }),
                    (asset) =>
                      `Unidad ${asset.code} asignada a esta obra (${assetStatusLabel(asset.status)}). Solo una unidad «Disponible» se asigna; cualquier otro estado responde obra.asset_unavailable con el estado como motivo.`,
                  )
                }
              >
                Asignar a esta obra
              </Button>
            ) : null}
            {canWrite ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={saving || targetIssue !== null}
                  onClick={() =>
                    void handleTransition(
                      () => setAssetMaintenance(assetId.trim()),
                      (asset) =>
                        `Unidad ${asset.code} en mantenimiento: queda desvinculada de la obra y el tablero la lista en «Equipos en mantenimiento».`,
                    )
                  }
                >
                  Enviar a mantenimiento
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={saving || targetIssue !== null}
                  onClick={() =>
                    void handleTransition(
                      () => retireAsset(assetId.trim()),
                      (asset) =>
                        `Unidad ${asset.code} retirada. Una unidad retirada no se vuelve a asignar ni admite lecturas.`,
                    )
                  }
                >
                  Retirar unidad
                </Button>
              </>
            ) : null}
            {!canAssign && !canWrite ? (
              <p className="text-xs text-muted-foreground">
                Su rol no asigna unidades ni cambia su estado: la única acción de equipos que conserva
                es anotar lecturas.
              </p>
            ) : null}
          </div>

          {lastAsset === null ? null : (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant={assetStatusVariant(lastAsset.status)}>
                {assetStatusLabel(lastAsset.status)}
              </Badge>
              <span className="tabular font-mono">{lastAsset.code}</span>
              <span>{lastAsset.kind}</span>
              <span className="text-[0.6875rem]">
                {assetCanBeAssigned(lastAsset.status)
                  ? 'asignable'
                  : assetCanBeRead(lastAsset.status)
                    ? 'no asignable · todavía legible'
                    : 'retirado · ni asignable ni legible'}
              </span>
            </div>
          )}
        </div>

        {canMark ? (
          <form className="flex flex-col gap-4 border-t border-border pt-4" onSubmit={handleReading} noValidate>
            <p className="text-xs text-muted-foreground">
              Anotar exige <code className="font-mono">attendance.mark</code> y una asignación activa
              a la obra donde está la unidad. Gerencia y jefatura de obra quedan exentas de la
              asignación porque su alcance de organización ya cubre la obra.
            </p>
            <div className="grid items-start gap-4 sm:grid-cols-3">
              <LiveField id="reading-kind" label="Tipo de lectura" issue={null} touched={false}>
                <Select
                  id="reading-kind"
                  value={reading.kind}
                  onChange={(event) => setReading((current) => ({ ...current, kind: event.target.value }))}
                >
                  {ASSET_READING_KIND_SUGGESTIONS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </Select>
              </LiveField>
              <LiveField
                id="reading-value"
                label="Valor del horómetro"
                issue={valueIssue}
                touched={show('value')}
                hint="Horas o kilómetros según la unidad; el API lo guarda como número."
              >
                <Input
                  id="reading-value"
                  inputMode="decimal"
                  placeholder="128.5"
                  value={reading.value}
                  onChange={(event) => setReading((current) => ({ ...current, value: event.target.value }))}
                  onBlur={() => touch('value')}
                />
              </LiveField>
              <div className="flex items-end sm:pt-6">
                <Button variant="primary" size="sm" type="submit" disabled={saving}>
                  {saving ? 'Anotando…' : 'Anotar lectura'}
                </Button>
              </div>
            </div>
          </form>
        ) : (
          <p className="text-xs text-muted-foreground">
            Su rol no tiene <code className="font-mono">attendance.mark</code>: la lectura manual no
            se ofrece.
          </p>
        )}

        <WriteResult failure={failure} success={success} />
      </CardContent>
    </Card>
  );
}

function AssetsSkeleton() {
  return (
    <ul aria-hidden className="flex flex-col">
      {[0, 1].map((index) => (
        <li key={index} className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0">
          <Skeleton className="ob-shimmer h-3 w-40" delay={index * 90} />
          <Skeleton className="ob-shimmer h-3 w-full max-w-xl" delay={index * 90 + 60} />
          <Skeleton className="ob-shimmer h-2.5 w-56" delay={index * 90 + 120} />
        </li>
      ))}
    </ul>
  );
}
