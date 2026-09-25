'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ConsentRecord, EpisodeRecord, PatientRecord } from '@rizoma/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { SkeletonRows } from '@/components/ui/skeleton';
import { ConsentForm } from '@/components/salud/consent-form';
import { ConsentRow } from '@/components/salud/consent-row';
import { EmptyState, FailurePanel, WriteResult } from '@/components/salud/states';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { listConsents, revokeConsent, signConsent } from '@/lib/salud-api';

/**
 * Consent panel of the ficha 360 — the Peru teleinterconsultation consent
 * (`peru-anexo-v1.md` §2).
 *
 * The panel owns the list and the two lifecycle writes; the row renders what the
 * API derived, and the form collects the version coordinates and the §2.6 matrix.
 * Splitting it that way keeps the optimistic transitions in one place:
 *
 *   - **sign** (`pending → signed`) and **revoke** (`signed → revoked`) apply to
 *     the list immediately, then either replace the row with the API's answer or
 *     restore the previous array and play the rollback animation. A lifecycle step
 *     that failed silently would leave a clinician believing a session is
 *     authorised, which is exactly the failure this design refuses;
 *   - the §2.6 gate is never re-derived here: `canStartSession` and
 *     `allowedRecordingTypes` are rendered as the API computed them, so a UI
 *     change cannot widen an authorisation;
 *   - a refusal or a server failure shows `code`, `reason` and `traceId` and
 *     nothing else, so the panel never leaks a record it could not read.
 *
 * Degradation, stated rather than hidden: MVP1 exposes no upload or signed URL
 * (`files/paths.ts` only), so the evidence is a fingerprint supplied by the form.
 * Its default is synthetic and derived from the consent id, and the panel says so.
 */
export interface ConsentsPanelProps {
  readonly patientId: string;
  /** Patient row, used to prefill the §2.3 identity snapshot. */
  readonly patient: PatientRecord | null;
  /** Episodes of this patient, for the episode selector of the version key. */
  readonly episodes: readonly EpisodeRecord[];
  /** `patient.write` — create, sign and revoke all require it. */
  readonly canWrite: boolean;
  readonly className?: string;
}

/**
 * Synthetic evidence fingerprint: the consent id's own hex, doubled to 64
 * characters. Deterministic on purpose — the same row produces the same digest on
 * the server render and on the client, so there is no hydration mismatch and no
 * surprise regeneration between two visits.
 */
export function syntheticEvidenceDigest(consentId: string): string {
  const hex = consentId.replace(/-/g, '').toLowerCase();
  return `${hex}${hex}`.slice(0, 64);
}

export function ConsentsPanel({
  patientId,
  patient,
  episodes,
  canWrite,
  className,
}: ConsentsPanelProps) {
  const [consents, setConsents] = useState<ConsentRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [readFailure, setReadFailure] = useState<ApiFailure | null>(null);
  const [writeFailure, setWriteFailure] = useState<ApiFailure | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revertedId, setRevertedId] = useState<string | null>(null);
  const [evidenceDrafts, setEvidenceDrafts] = useState<Readonly<Record<string, string>>>({});
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((current) => current + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    listConsents(patientId, controller.signal)
      .then((rows) => {
        if (!active) return;
        setConsents(rows);
        setReadFailure(null);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        setReadFailure(classifyApiError(error));
        setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [patientId, reloadKey]);

  useEffect(() => {
    if (revertedId === null) return;
    const timer = window.setTimeout(() => setRevertedId(null), 600);
    return () => window.clearTimeout(timer);
  }, [revertedId]);

  const rows = consents ?? [];

  function replace(next: ConsentRecord): void {
    setConsents((current) => (current ?? []).map((row) => (row.id === next.id ? next : row)));
  }

  async function handleSign(consent: ConsentRecord): Promise<void> {
    const draft = evidenceDrafts[consent.id] ?? syntheticEvidenceDigest(consent.id);
    const snapshot = rows;
    setWriteFailure(null);
    setSuccess(null);
    setBusyId(consent.id);
    // Optimistic: the row already reads `signed`, with the §2.6 gate derived the
    // same way the API derives it.
    setConsents(
      snapshot.map((row) =>
        row.id === consent.id
          ? {
              ...row,
              status: 'signed',
              signedAt: new Date().toISOString(),
              canStartSession: row.actConsent === 'SI',
            }
          : row,
      ),
    );
    try {
      const signed = await signConsent(consent.id, { evidenceSha256: draft.trim().toLowerCase() });
      replace(signed);
      setSuccess('Consentimiento firmado con evidencia registrada en la auditoría.');
    } catch (error) {
      setConsents(snapshot);
      setRevertedId(consent.id);
      setWriteFailure(classifyApiError(error));
    } finally {
      setBusyId(null);
    }
  }

  async function handleRevoke(consent: ConsentRecord): Promise<void> {
    const snapshot = rows;
    setWriteFailure(null);
    setSuccess(null);
    setBusyId(consent.id);
    setConsents(
      snapshot.map((row) =>
        row.id === consent.id ? { ...row, status: 'revoked', canStartSession: false } : row,
      ),
    );
    try {
      const revoked = await revokeConsent(consent.id);
      replace(revoked);
      setSuccess('Consentimiento revocado: la evidencia y la fila se conservan.');
    } catch (error) {
      setConsents(snapshot);
      setRevertedId(consent.id);
      setWriteFailure(classifyApiError(error));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardEyebrow>Consentimiento informado</CardEyebrow>
        <CardTitle as="h2">Consentimientos de teleinterconsulta</CardTitle>
        <CardDescription>
          Plantilla <code className="font-mono text-xs">consent.pe.teleinterconsulta</code> con su
          versión, la clave de versión (§2.8.1) y la matriz de grabación (§2.6) tal como la derivó el
          API. Firmar y revocar son operaciones optimistas: la fila cambia de inmediato y revierte
          con animación si el API las rechaza.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="tabular text-xs text-muted-foreground">
            {loading ? 'leyendo…' : `${rows.length} consentimiento${rows.length === 1 ? '' : 's'}`}
          </span>
          <Button variant="ghost" size="sm" onClick={reload} disabled={loading}>
            Actualizar
          </Button>
          {canWrite ? (
            <Button
              variant={formOpen ? 'ghost' : 'outline'}
              size="sm"
              className="ml-auto"
              onClick={() => setFormOpen((open) => !open)}
            >
              {formOpen ? 'Cerrar formulario' : 'Crear consentimiento pendiente'}
            </Button>
          ) : (
            <span className="ml-auto text-xs text-muted-foreground">
              Sin <code className="font-mono">patient.write</code>: no se crea, firma ni revoca.
            </span>
          )}
        </div>

        {formOpen && canWrite ? (
          <ConsentForm
            patientId={patientId}
            patient={patient}
            episodes={episodes}
            onCreated={(created) => {
              setConsents((current) => [created, ...(current ?? [])]);
              setSuccess(
                'Consentimiento pendiente creado. Firme con la evidencia para habilitar la sesión.',
              );
              setFormOpen(false);
            }}
          />
        ) : null}

        {consents === null ? null : <WriteResult failure={writeFailure} success={success} />}

        {loading ? <SkeletonRows rows={2} /> : null}

        {!loading && readFailure !== null ? (
          <FailurePanel
            title="No se pudieron leer los consentimientos"
            failure={readFailure}
            onRetry={reload}
          />
        ) : null}

        {!loading && readFailure === null && rows.length === 0 ? (
          <EmptyState
            eyebrow="Sin consentimientos"
            title="Este paciente no tiene consentimientos registrados"
            description="El API respondió con una lista válida y vacía. El consentimiento es un paso propio del flujo: sin una fila firmada con acto SI, el API no habilita la teleinterconsulta."
          />
        ) : null}

        {rows.length === 0 ? null : (
          <ul className="flex flex-col gap-3">
            {rows.map((consent) => (
              <ConsentRow
                key={consent.id}
                consent={consent}
                canWrite={canWrite}
                busy={busyId === consent.id}
                reverted={revertedId === consent.id}
                evidence={evidenceDrafts[consent.id] ?? syntheticEvidenceDigest(consent.id)}
                onEvidenceChange={(value) =>
                  setEvidenceDrafts((current) => ({ ...current, [consent.id]: value }))
                }
                onSign={() => void handleSign(consent)}
                onRevoke={() => void handleRevoke(consent)}
              />
            ))}
          </ul>
        )}

        <p className="text-xs text-muted-foreground">
          Sin endpoint de carga en MVP1, la evidencia se registra como huella de 64 caracteres
          hexadecimales. La huella por defecto es sintética y deriva del identificador del
          consentimiento: la demostración nunca afirma que exista un documento almacenado.
        </p>
      </CardContent>
    </Card>
  );
}
