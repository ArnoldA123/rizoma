'use client';

import {
  CONSENT_RECORD_TYPES,
  checkSha256Field,
  type ConsentRecord,
  type RecordingMark,
} from '@rizoma/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldMessage, fieldStateProps } from '@/components/ui/field-feedback';
import { Input } from '@/components/ui/input';
import { CONSENT_STATUS_LABELS, consentStatusVariant, documentTypeLabel, recordTypeLabel } from '@/lib/labels';
import { formatUtcDate, utcDateOf } from '@/lib/salud-time';
import { cn } from '@/lib/utils';

/**
 * One consent row of the ficha 360.
 *
 * Presentational on purpose: it renders exactly what the API derived
 * (`canStartSession`, `allowedRecordingTypes`, the §2.6 marks) and reports the
 * three intents a role may have (sign with an evidence fingerprint, revoke, or
 * nothing) to the panel that owns the optimistic transition. Keeping the
 * decision out of the row is what lets the panel revert a failed write without
 * the row having to know about failure.
 *
 * The `reverted` flag is the visible half of an optimistic rollback: the row
 * plays `sd-revert` while the panel shows the envelope of the refusal.
 */
export interface ConsentRowProps {
  readonly consent: ConsentRecord;
  /** `patient.write` — sign and revoke both require it. */
  readonly canWrite: boolean;
  readonly busy: boolean;
  readonly reverted: boolean;
  /** Evidence fingerprint the user is about to sign with. */
  readonly evidence: string;
  readonly onEvidenceChange: (value: string) => void;
  readonly onSign: () => void;
  readonly onRevoke: () => void;
}

export function ConsentRow({
  consent,
  canWrite,
  busy,
  reverted,
  evidence,
  onEvidenceChange,
  onSign,
  onRevoke,
}: ConsentRowProps) {
  const digestIssue = checkSha256Field('evidenceSha256', evidence);
  const marks = CONSENT_RECORD_TYPES.map((type) => ({
    type,
    mark: (consent.recording[type] ?? 'NO') as RecordingMark,
  }));

  return (
    <li
      className={cn(
        'flex flex-col gap-3 rounded-md border border-border px-4 py-3.5',
        reverted && 'sd-revert',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={consentStatusVariant(consent.status)}>
          {CONSENT_STATUS_LABELS[consent.status] ?? consent.status}
        </Badge>
        <Badge variant={consent.actConsent === 'SI' ? 'tinted' : 'danger'}>
          Acto médico: {consent.actConsent}
        </Badge>
        <Badge variant={consent.canStartSession ? 'tinted' : 'outline'}>
          {consent.canStartSession ? 'Habilita la sesión' : 'No habilita la sesión'}
        </Badge>
        <span className="tabular ml-auto font-mono text-[0.6875rem] text-muted-foreground">
          {consent.templateCode} v{consent.templateVersion === '' ? '—' : consent.templateVersion}
        </span>
      </div>

      <dl className="tabular grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">clave de versión</dt>
        <dd className="font-mono break-all" title={consent.versionKey}>
          {consent.versionKey === '' ? '—' : consent.versionKey}
        </dd>
        <dt className="text-muted-foreground">episodio</dt>
        <dd className="font-mono break-all">{consent.episodeId === '' ? '—' : consent.episodeId}</dd>
        <dt className="text-muted-foreground">centros</dt>
        <dd className="font-mono break-all">
          {consent.consultingCenter === '' ? '—' : consent.consultingCenter.slice(0, 8)}… →{' '}
          {consent.consultorCenter === '' ? '—' : consent.consultorCenter.slice(0, 8)}…
        </dd>
        <dt className="text-muted-foreground">informado por</dt>
        <dd>{consent.informedBy === '' ? '—' : consent.informedBy}</dd>
        <dt className="text-muted-foreground">firmado</dt>
        <dd>
          {consent.signedAt === null
            ? 'sin firma'
            : `${formatUtcDate(utcDateOf(consent.signedAt) ?? '')} (UTC)`}
        </dd>
        <dt className="text-muted-foreground">evidencia</dt>
        <dd className="font-mono break-all">
          {consent.evidenceAttachmentId === null ? 'sin adjunto' : consent.evidenceAttachmentId}
        </dd>
        <dt className="text-muted-foreground">identidad §2.3</dt>
        <dd>
          {consent.patientName === '' ? '—' : consent.patientName} ·{' '}
          {documentTypeLabel(consent.docType)} {consent.docNumber}
        </dd>
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Grabación autorizada:</span>
        {marks.map(({ type, mark }) => (
          <Badge key={type} variant={mark === 'SI' ? 'tinted' : 'outline'} title={`${type}: ${mark}`}>
            {recordTypeLabel(type)}: {mark}
          </Badge>
        ))}
        <span className="tabular text-[0.6875rem] text-muted-foreground">
          {consent.allowedRecordingTypes.length === 0
            ? 'sin tipos autorizados'
            : `autorizados: ${consent.allowedRecordingTypes.map(recordTypeLabel).join(', ')}`}
        </span>
      </div>

      {!canWrite ? null : consent.status === 'pending' ? (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-end">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <label htmlFor={`evidence-${consent.id}`} className="text-[0.8125rem] font-medium">
                Huella de la evidencia (sha256)
              </label>
              <Input
                id={`evidence-${consent.id}`}
                className="font-mono text-xs"
                spellCheck={false}
                value={evidence}
                onChange={(event) => onEvidenceChange(event.target.value)}
                {...fieldStateProps(digestIssue, true)}
              />
            </div>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || digestIssue !== null}
              onClick={onSign}
            >
              {busy ? 'Firmando…' : 'Firmar'}
            </Button>
          </div>
          <FieldMessage
            issue={digestIssue}
            touched
            validLabel="Huella válida: se almacenará como adjunto de evidencia."
          />
        </div>
      ) : consent.status === 'signed' ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
          <Button variant="outline" size="sm" disabled={busy} onClick={onRevoke}>
            {busy ? 'Revocando…' : 'Revocar consentimiento'}
          </Button>
          <span className="text-xs text-muted-foreground">
            La revocación conserva la fila y la evidencia; solo bloquea nuevas sesiones.
          </span>
        </div>
      ) : (
        <p className="border-t border-border pt-3 text-xs text-muted-foreground">
          Estado {CONSENT_STATUS_LABELS[consent.status] ?? consent.status}: no admite firmar ni
          revocar. La matriz de §2.8 solo permite <code className="font-mono">pending → signed</code>{' '}
          y <code className="font-mono">signed → revoked</code>.
        </p>
      )}
    </li>
  );
}
