'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  CONSENT_RECORD_TYPES,
  DOCUMENT_TYPES,
  RECORDING_MARKS,
  checkRequiredText,
  checkUuidField,
  documentTypeSchema,
  firstIssue,
  type ConsentRecord,
  type DocumentType,
  type EpisodeRecord,
  type FieldCheck,
  type PatientRecord,
  type RecordingMark,
} from '@rizoma/contracts';
import { Button } from '@/components/ui/button';
import { EntitySelector, type EntityItem } from '@/components/ui/entity-select';
import { FieldMessage, fieldStateProps } from '@/components/ui/field-feedback';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import { FailurePanel } from '@/components/salud/states';
import { DOCUMENT_TYPE_LABELS, recordTypeLabel } from '@/lib/labels';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { createConsent } from '@/lib/salud-api';
import { listOrgNodes } from '@/lib/org-api';
import { cn } from '@/lib/utils';

/**
 * Creation form of the teleinterconsultation consent (`peru-anexo-v1.md` §2).
 *
 * It collects exactly what the API requires and nothing more:
 *   - the §2.8.1 version coordinates (episode + consulting/consultor centre pair
 *     + `informed_by`), which is why the form asks for a centre *pair* and not a
 *     single centre;
 *   - the §2.3 identity snapshot, prefilled from the patient row because the
 *     snapshot has to be reproducible from the signed consent;
 *   - the §2.6 decision matrix: one toggle for the medical act and one per
 *     recording type. Every type is submitted with an explicit `SI`/`NO` mark
 *     (never omitted) because the API rejects an empty map and treats an unmarked
 *     type as *not* authorised — the form must not rely on a default it does not
 *     control;
 *   - the two centre identifiers are picked from the sede list with a
 *     browser-side search, the same way the sede is picked on the
 *     registration form.
 */
export interface ConsentFormProps {
  readonly patientId: string;
  /** Patient row, source of the prefilled §2.3 snapshot. */
  readonly patient: PatientRecord | null;
  /** Episodes of this patient, for the version-key selector. */
  readonly episodes: readonly EpisodeRecord[];
  readonly onCreated: (consent: ConsentRecord) => void;
  readonly className?: string;
}

export function ConsentForm({ patientId, patient, episodes, onCreated, className }: ConsentFormProps) {
  const [episodeId, setEpisodeId] = useState('');
  const [consultingCenter, setConsultingCenter] = useState('');
  const [consultorCenter, setConsultorCenter] = useState('');
  const [informedBy, setInformedBy] = useState('');
  const [patientName, setPatientName] = useState(patient?.personName ?? '');
  const [docNumber, setDocNumber] = useState(patient?.documentNumber ?? '');
  const [actConsent, setActConsent] = useState(true);
  const [recording, setRecording] = useState<Readonly<Record<string, boolean>>>({
    imagenes_ayuda: false,
    fotografias: false,
    video: false,
    audio: false,
  });
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

  const docType: DocumentType = documentTypeSchema.catch('dni').parse(patient?.documentType);
  const checks: Readonly<Record<string, FieldCheck>> = {
    episodeId: checkUuidField('episodeId', episodeId),
    consultingCenter: checkUuidField('consultingCenter', consultingCenter),
    consultorCenter: checkUuidField('consultorCenter', consultorCenter),
    informedBy: checkRequiredText('informedBy', informedBy, 120),
    patientName: checkRequiredText('patientName', patientName, 120),
    docNumber: checkRequiredText('docNumber', docNumber, 32),
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setTouched(true);
    setFailure(null);
    if (firstIssue(checks) !== null) return;

    const marks: Record<string, RecordingMark> = {};
    for (const type of CONSENT_RECORD_TYPES) marks[type] = recording[type] === true ? 'SI' : 'NO';

    setSaving(true);
    try {
      const created = await createConsent({
        patientId,
        episodeId: episodeId.trim(),
        consultingCenter: consultingCenter.trim(),
        consultorCenter: consultorCenter.trim(),
        informedBy: informedBy.trim(),
        patientName: patientName.trim(),
        docType,
        docNumber: docNumber.trim(),
        actConsent: actConsent ? 'SI' : 'NO',
        recording: marks,
      });
      setEpisodeId('');
      setConsultingCenter('');
      setConsultorCenter('');
      setInformedBy('');
      setTouched(false);
      onCreated(created);
    } catch (error) {
      setFailure(classifyApiError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className={cn(
        'sd-rise flex flex-col gap-5 rounded-md border border-border bg-secondary p-4',
        className,
      )}
      onSubmit={handleSubmit}
      noValidate
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="consent-episode" className="text-[0.8125rem] font-medium">
            Episodio
          </label>
          <Select
            id="consent-episode"
            value={episodeId}
            onChange={(event) => setEpisodeId(event.target.value)}
            onBlur={() => setTouched(true)}
          >
            <option value="">Seleccione un episodio</option>
            {episodes.map((episode) => {
              const date = (episode.openedAt ?? '').slice(0, 10);
              return (
                <option key={episode.id} value={episode.id}>
                  {episode.specialty}{date === '' ? '' : ` · ${date}`} ·{' '}
                  {episode.status === 'open' ? 'abierto' : 'cerrado'}
                </option>
              );
            })}
          </Select>
          <FieldMessage issue={checks.episodeId ?? null} touched={touched} validLabel="Dato aceptado." />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="consent-informed-by" className="text-[0.8125rem] font-medium">
            Informado por
          </label>
          <Input
            id="consent-informed-by"
            value={informedBy}
            maxLength={120}
            onChange={(event) => setInformedBy(event.target.value)}
            onBlur={() => setTouched(true)}
            {...fieldStateProps(checks.informedBy ?? null, touched)}
          />
          <FieldMessage issue={checks.informedBy ?? null} touched={touched} validLabel="Dato aceptado." />
        </div>

        <div className="flex flex-col gap-1.5">
          <EntitySelector
            label="Centro consultor"
            items={sedeItems}
            value={consultingCenter === '' ? null : consultingCenter}
            onChange={(id) => {
              setConsultingCenter(id ?? '');
              setTouched(true);
            }}
            placeholder="Seleccionar sede…"
            searchPlaceholder="Buscar por nombre…"
          />
          <FieldMessage
            issue={checks.consultingCenter ?? null}
            touched={touched}
            validLabel="Dato aceptado."
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <EntitySelector
            label="Centro consultado"
            items={sedeItems}
            value={consultorCenter === '' ? null : consultorCenter}
            onChange={(id) => {
              setConsultorCenter(id ?? '');
              setTouched(true);
            }}
            placeholder="Seleccionar sede…"
            searchPlaceholder="Buscar por nombre…"
          />
          <FieldMessage
            issue={checks.consultorCenter ?? null}
            touched={touched}
            validLabel="Dato aceptado."
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="consent-patient-name" className="text-[0.8125rem] font-medium">
            Nombre del paciente (§2.3)
          </label>
          <Input
            id="consent-patient-name"
            value={patientName}
            maxLength={120}
            onChange={(event) => setPatientName(event.target.value)}
            onBlur={() => setTouched(true)}
            {...fieldStateProps(checks.patientName ?? null, touched)}
          />
          <FieldMessage issue={checks.patientName ?? null} touched={touched} validLabel="Dato aceptado." />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="consent-doc-number" className="text-[0.8125rem] font-medium">
            Documento · {DOCUMENT_TYPE_LABELS[docType]}
          </label>
          <Input
            id="consent-doc-number"
            className="font-mono text-xs"
            value={docNumber}
            maxLength={32}
            onChange={(event) => setDocNumber(event.target.value)}
            onBlur={() => setTouched(true)}
            {...fieldStateProps(checks.docNumber ?? null, touched)}
          />
          <FieldMessage issue={checks.docNumber ?? null} touched={touched} validLabel="Dato aceptado." />
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <Toggle
          label="Acto médico"
          hint="Solo SI autoriza la teleinterconsulta (§2.6)."
          checked={actConsent}
          onChange={setActConsent}
          states={['NO', 'SI']}
        />
        {CONSENT_RECORD_TYPES.map((type) => (
          <Toggle
            key={type}
            label={recordTypeLabel(type)}
            hint={
              recording[type] === true
                ? 'Grabación autorizada para este tipo.'
                : 'Sin autorización: este tipo no se graba ni se almacena.'
            }
            checked={recording[type] === true}
            onChange={(next) => setRecording((current) => ({ ...current, [type]: next }))}
          />
        ))}
        <p className="text-xs text-muted-foreground">
          Los cuatro tipos viajan siempre con una marca explícita{' '}
          <code className="font-mono">SI</code> o <code className="font-mono">NO</code>: el API
          rechaza un mapa vacío y trata un tipo sin marca como no autorizado. Marcas admitidas:{' '}
          {RECORDING_MARKS.join(' / ')}. Documentos admitidos: {DOCUMENT_TYPES.join(' / ')}.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" type="submit" size="sm" disabled={saving}>
          {saving ? 'Creando…' : 'Crear consentimiento pendiente'}
        </Button>
        <span className="text-xs text-muted-foreground">
          La fila queda en <code className="font-mono">pending</code> hasta que se firme con la
          evidencia.
        </span>
      </div>

      {failure === null ? null : (
        <FailurePanel title="El consentimiento no se creó" failure={failure} />
      )}
    </form>
  );
}
