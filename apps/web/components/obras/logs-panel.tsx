'use client';

import { useMemo, useState, type FormEvent } from 'react';
import {
  SITE_LOG_TEXT_MAX,
  checkOptionalUuidField,
  checkRequiredText,
  firstIssue,
  siteLogIsDraft,
  type FieldCheck,
  type SiteLogRecord,
} from '@rizoma/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { CharCounter, LiveField } from '@/components/ui/field-feedback';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, FailurePanel, WriteResult } from '@/components/ui/states';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { formatUtcStamp } from '@/lib/format';
import { siteLogStatusLabel, siteLogStatusVariant } from '@/lib/labels';
import { createSiteLog, listSiteLogs, publishSiteLog } from '@/lib/obras-api';
import { useResource } from '@/lib/use-resource';

/**
 * Bitácora de obra: entradas en borrador, publicación y evidencia adjunta.
 *
 * The lifecycle is the panel's spine, and it is the service's, not a preference:
 * a log is always created as `draft` (the POST body has no `status` field) and
 * published through its own endpoint, which refuses anything that is not a draft
 * with `obra.state_denied`. So the action on a row is offered exactly when
 * `siteLogIsDraft(row)` holds, and a published entry is final in MVP1.
 *
 * **Photos degrade to metadata, and the panel says so.** MVP1 ships no file
 * endpoints (`files/paths.ts` only computes keys), so there is no upload to offer:
 * the field collects the `attachment_ids` the service stores in a UUID array, and
 * the copy states that the photo itself travels nowhere. Offering a file input
 * that silently dropped the bytes would be the dishonest version of this screen.
 *
 * The primary controls are plain `Button variant="primary"`: the single magnetic
 * CTA of the ficha belongs to the staff panel (W4).
 */
export interface LogsPanelProps {
  readonly siteId: string;
  /** `attendance.mark` — append a draft and publish it (on-site write). */
  readonly canMark: boolean;
  readonly className?: string;
}

interface Draft {
  text: string;
  attachments: string;
}

const EMPTY_DRAFT: Draft = { text: '', attachments: '' };

export function LogsPanel({ siteId, canMark, className }: LogsPanelProps) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [touched, setTouched] = useState<Readonly<Record<string, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const logs = useResource<SiteLogRecord[]>(`obras-logs:${siteId}`, (signal) =>
    listSiteLogs(siteId, signal),
  );
  const rows = logs.data ?? [];

  const checks: Readonly<Record<string, FieldCheck>> = useMemo(
    () => ({
      text: checkRequiredText('text', draft.text, SITE_LOG_TEXT_MAX),
      // One UUID per line or comma-separated; each token is validated as an id.
      attachments: firstAttachmentIssue(draft.attachments),
    }),
    [draft],
  );

  const show = (field: string): boolean => touched[field] === true || submitted;

  function touch(field: string): void {
    setTouched((current) => ({ ...current, [field]: true }));
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitted(true);
    setFailure(null);
    setSuccess(null);
    if (firstIssue(checks) !== null) return;

    setSaving(true);
    try {
      const created = await createSiteLog(siteId, {
        text: draft.text.trim(),
        attachmentIds: parseAttachments(draft.attachments),
      });
      logs.reloadSilently();
      setDraft(EMPTY_DRAFT);
      setTouched({});
      setSubmitted(false);
      setSuccess(
        `Entrada creada como «${siteLogStatusLabel(created.status)}» (${formatUtcStamp(created.at)}). Un borrador solo es visible para quien puede leer la bitácora de la obra; publicarlo es el paso siguiente.`,
      );
    } catch (error) {
      setFailure(classifyApiError(error));
    } finally {
      setSaving(false);
    }
  }

  async function handlePublish(row: SiteLogRecord): Promise<void> {
    setFailure(null);
    setSuccess(null);
    setSaving(true);
    try {
      const published = await publishSiteLog(siteId, row.id);
      logs.reloadSilently();
      setSuccess(
        `Entrada publicada (${siteLogStatusLabel(published.status)}). Publicar es una transición de una sola vez: una entrada ya publicada responde obra.state_denied.`,
      );
    } catch (error) {
      setFailure(classifyApiError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className={className} id="bitacora-obra">
      <CardHeader>
        <CardEyebrow>Bitácora</CardEyebrow>
        <CardTitle as="h2">Registro de la obra</CardTitle>
        <CardDescription>
          Cada entrada nace como borrador y se publica con su propio paso. Las fotos se degradan a
          metadatos: MVP1 no expone endpoints de archivos, así que aquí se registran identificadores
          de adjunto y el archivo no viaja.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[0.8125rem] font-medium">Entradas de la obra</span>
          <span className="tabular ml-auto text-xs text-muted-foreground">
            {logs.loading ? 'leyendo…' : `${rows.length} entradas`}
          </span>
          <Button variant="ghost" size="sm" onClick={logs.reload} disabled={logs.loading}>
            Actualizar
          </Button>
        </div>

        {logs.loading ? <LogsSkeleton /> : null}

        {!logs.loading && logs.failure !== null ? (
          <FailurePanel
            title="No se pudo leer la bitácora de la obra"
            failure={logs.failure}
            onRetry={logs.reload}
          />
        ) : null}

        {!logs.loading && logs.failure === null && rows.length === 0 ? (
          <EmptyState
            eyebrow="Sin entradas"
            title="La bitácora está vacía"
            description="El API respondió con una lista válida y vacía. La primera entrada suele ser el inicio de obra; queda en borrador hasta que alguien con marca en obra la publique."
          />
        ) : null}

        {!logs.loading && logs.failure === null && rows.length > 0 ? (
          <ul className="flex flex-col">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-start justify-between gap-3 border-b border-border py-3 last:border-b-0"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={siteLogStatusVariant(row.status)}>
                      {siteLogStatusLabel(row.status)}
                    </Badge>
                    <span className="tabular text-xs text-muted-foreground">
                      {formatUtcStamp(row.at)}
                    </span>
                    {row.attachmentIds.length === 0 ? null : (
                      <span className="text-xs text-muted-foreground">
                        {row.attachmentIds.length}{' '}
                        {row.attachmentIds.length === 1 ? 'adjunto' : 'adjuntos'} (solo metadatos)
                      </span>
                    )}
                  </div>
                  <p className="text-[0.9375rem] whitespace-pre-wrap">{row.text}</p>
                  <span className="tabular font-mono text-[0.6875rem] text-muted-foreground">
                    entrada {row.id} · autor {row.authorId}
                  </span>
                </div>
                {canMark && siteLogIsDraft(row) ? (
                  <Button variant="outline" size="sm" disabled={saving} onClick={() => void handlePublish(row)}>
                    Publicar
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {canMark ? (
          <form className="flex flex-col gap-4 border-t border-border pt-4" onSubmit={handleCreate} noValidate>
            <p className="text-xs text-muted-foreground">
              Escribir exige <code className="font-mono">attendance.mark</code> y una asignación
              activa a esta obra — gerencia y jefatura de obra quedan exentas por su alcance de
              organización. La bitácora es un registro de campo: el autor se toma del token, no del
              formulario.
            </p>
            <LiveField
              id="log-text"
              label="Entrada"
              issue={checks.text ?? null}
              touched={show('text')}
              validLabel="Entrada lista para guardar como borrador."
            >
              <textarea
                id="log-text"
                rows={4}
                maxLength={SITE_LOG_TEXT_MAX}
                spellCheck={false}
                value={draft.text}
                onChange={(event) => setDraft((current) => ({ ...current, text: event.target.value }))}
                onBlur={() => touch('text')}
                placeholder="Se vació la cimentación del eje A; cuadrilla de 4 personas."
                className="w-full rounded-md border border-input bg-card p-3 text-[0.8125rem] leading-5 text-foreground placeholder:text-muted-foreground"
              />
            </LiveField>
            <div className="flex justify-end">
              <CharCounter value={draft.text} max={SITE_LOG_TEXT_MAX} />
            </div>

            <LiveField
              id="log-attachments"
              label="Adjuntos (UUID, uno por línea)"
              issue={checks.attachments}
              touched={show('attachments')}
              hint="Metadatos: MVP1 no tiene endpoints de archivos, así que la foto no se sube. El registro guarda los identificadores de adjunto y el texto es la evidencia real."
            >
              <textarea
                id="log-attachments"
                rows={2}
                spellCheck={false}
                value={draft.attachments}
                onChange={(event) => setDraft((current) => ({ ...current, attachments: event.target.value }))}
                onBlur={() => touch('attachments')}
                placeholder="ffffffff-ffff-4fff-8fff-ffffffffffff"
                className="tabular w-full rounded-md border border-input bg-card p-3 font-mono text-xs leading-5 text-foreground placeholder:text-muted-foreground"
              />
            </LiveField>

            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" size="sm" type="submit" disabled={saving}>
                {saving ? 'Guardando…' : 'Guardar borrador'}
              </Button>
              <span className="text-xs text-muted-foreground">
                El borrador es el primer estado, no un estado intermedio: el API no acepta crear una
                entrada ya publicada.
              </span>
            </div>
          </form>
        ) : (
          <p className="text-xs text-muted-foreground">
            Su rol no tiene <code className="font-mono">attendance.mark</code> ni una asignación
            activa: escribir y publicar en la bitácora no se ofrece.
          </p>
        )}

        <WriteResult failure={failure} success={success} />
      </CardContent>
    </Card>
  );
}

/** Splits the attachments textarea into identifiers, ignoring blank lines. */
function parseAttachments(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((token) => token.trim())
    .filter((token) => token !== '');
}

/** First invalid attachment token, or `null` when every token is a UUID or blank. */
function firstAttachmentIssue(value: string): FieldCheck {
  for (const token of parseAttachments(value)) {
    const issue = checkOptionalUuidField('attachmentIds', token);
    if (issue !== null) return issue;
  }
  return null;
}

function LogsSkeleton() {
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
