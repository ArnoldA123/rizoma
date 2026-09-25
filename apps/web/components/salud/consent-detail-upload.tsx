'use client';

import { useRef, useState } from 'react';
import {
  FILE_SIZE_LIMIT_BYTES,
  fileDownloadResponseSchema,
  fileUploadRequestSchema,
  fileUploadResponseSchema,
  type FileDownloadResponse,
  type FileUploadResponse,
} from '@rizoma/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Evidence upload for the consent detail (H2, bases §4.5).
 *
 * The consent panel degrades the evidence to a metadata fingerprint because
 * MVP1 had no upload endpoint; this panel closes that gap for one file at a
 * time: it mints a signed PUT through the API proxy, uploads the bytes
 * straight to the object store, and hands the `attachmentId` back through
 * `onAttached` so the sign form can record the real evidence. The SHA-256 of
 * the bytes is reported through `onDigest` for the same reason — the sign
 * endpoint requires the fingerprint, and computing it here keeps the clinician
 * from typing 64 hex characters by hand.
 *
 * No permanent URL is ever rendered: the download leg mints a GET URL valid
 * for at most 5 minutes, and the link it produces says so.
 */
export interface ConsentDetailUploadProps {
  /** `patient.write` — without it the panel explains instead of offering. */
  readonly canWrite: boolean;
  /** Receives the registered `attachments` id after a successful PUT. */
  readonly onAttached?: (attachmentId: string) => void;
  /** Receives the SHA-256 of the uploaded bytes. */
  readonly onDigest?: (sha256: string) => void;
  readonly className?: string;
}

type Phase =
  | { readonly step: 'idle' }
  | { readonly step: 'requesting' }
  | { readonly step: 'uploading'; readonly grant: FileUploadResponse }
  | { readonly step: 'done'; readonly grant: FileUploadResponse; readonly digest: string }
  | { readonly step: 'failed'; readonly code: string; readonly message: string };

interface DownloadState {
  readonly loading: boolean;
  readonly grant: FileDownloadResponse | null;
  readonly failure: string | null;
}

const ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp';

function readEnvelope(payload: unknown): { code: string; message: string; traceId?: string } {
  if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>;
    const code = typeof record.code === 'string' ? record.code : 'upload.failed';
    const message = typeof record.message === 'string' ? record.message : 'La carga falló.';
    const traceId = typeof record.traceId === 'string' ? record.traceId : undefined;
    return { code, message, traceId };
  }
  return { code: 'upload.failed', message: 'La carga falló.' };
}

async function sha256OfBytes(buffer: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new Error('El navegador no expone crypto.subtle: la huella requiere HTTPS o localhost.');
  }
  const digest = await subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function ConsentDetailUpload({ canWrite, onAttached, onDigest, className }: ConsentDetailUploadProps) {
  const [phase, setPhase] = useState<Phase>({ step: 'idle' });
  const [fileName, setFileName] = useState<string | null>(null);
  const [download, setDownload] = useState<DownloadState>({ loading: false, grant: null, failure: null });
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function handleFile(file: File): Promise<void> {
    setFileName(file.name);
    setDownload({ loading: false, grant: null, failure: null });
    if (file.size > FILE_SIZE_LIMIT_BYTES) {
      setPhase({ step: 'failed', code: 'validation.failed', message: 'El archivo supera los 25 MiB.' });
      return;
    }
    const mime = file.type === '' ? 'application/pdf' : file.type;
    const request = fileUploadRequestSchema.safeParse({
      module: 'salud',
      mime,
      sizeBytes: file.size,
    });
    if (!request.success) {
      setPhase({ step: 'failed', code: 'validation.failed', message: 'Tipo de archivo no admitido para evidencia.' });
      return;
    }
    setPhase({ step: 'requesting' });
    try {
      const bytes = await file.arrayBuffer();
      const digest = await sha256OfBytes(bytes);
      const grantResponse = await fetch('/api/proxy/files/request-upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...request.data, sha256: digest }),
      });
      const grantPayload: unknown = await grantResponse.json().catch(() => null);
      if (!grantResponse.ok) {
        const envelope = readEnvelope(grantPayload);
        setPhase({ step: 'failed', code: envelope.code, message: envelope.message });
        return;
      }
      const grant = fileUploadResponseSchema.parse(grantPayload);
      setPhase({ step: 'uploading', grant });
      const putResponse = await fetch(grant.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': grant.mime },
        body: bytes,
      });
      if (!putResponse.ok) {
        setPhase({
          step: 'failed',
          code: 'upload.transport',
          message: `El objeto no aceptó los bytes (${putResponse.status}).`,
        });
        return;
      }
      setPhase({ step: 'done', grant, digest });
      onAttached?.(grant.attachmentId);
      onDigest?.(digest);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'La carga falló.';
      setPhase({ step: 'failed', code: 'upload.failed', message });
    }
  }

  async function handleDownload(attachmentId: string): Promise<void> {
    setDownload({ loading: true, grant: null, failure: null });
    try {
      const response = await fetch(`/api/proxy/files/${attachmentId}/download`);
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const envelope = readEnvelope(payload);
        setDownload({ loading: false, grant: null, failure: `${envelope.code}: ${envelope.message}` });
        return;
      }
      setDownload({ loading: false, grant: fileDownloadResponseSchema.parse(payload), failure: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'La descarga falló.';
      setDownload({ loading: false, grant: null, failure: message });
    }
  }

  const busy = phase.step === 'requesting' || phase.step === 'uploading';

  return (
    <Card className={className}>
      <CardHeader>
        <CardEyebrow>Evidencia</CardEyebrow>
        <CardTitle as="h3">Subir documento de consentimiento</CardTitle>
        <CardDescription>
          La URL de subida es firmada y de un solo uso efectivo: el registro en{' '}
          <code className="font-mono text-xs">attachments</code> existe antes de subir, y el enlace
          de descarga que se obtiene después caduca en 5 minutos.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!canWrite ? (
          <p className="text-xs text-muted-foreground">
            Sin <code className="font-mono">patient.write</code>: la subida no se ofrece.
          </p>
        ) : (
          <>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              disabled={busy}
              className="text-xs"
              aria-label="Documento de evidencia del consentimiento"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) void handleFile(file);
              }}
            />
            {fileName !== null ? (
              <p className="tabular text-xs text-muted-foreground">Archivo: {fileName}</p>
            ) : null}
          </>
        )}

        {phase.step === 'requesting' ? <p className="text-xs">Solicitando URL firmada…</p> : null}
        {phase.step === 'uploading' ? <p className="text-xs">Subiendo bytes al objeto…</p> : null}
        {phase.step === 'done' ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-emerald-700">
              Evidencia subida: <code className="font-mono">{phase.grant.attachmentId}</code>
            </p>
            <p className="tabular break-all font-mono text-[0.6875rem] text-muted-foreground">
              SHA-256 {phase.digest}
            </p>
            <div>
              <Button
                variant="outline"
                size="sm"
                disabled={download.loading}
                onClick={() => void handleDownload(phase.grant.attachmentId)}
              >
                {download.loading ? 'Firmando…' : 'Obtener enlace de descarga'}
              </Button>
            </div>
            {download.grant !== null ? (
              <p className="text-xs">
                <a className="underline" href={download.grant.downloadUrl} target="_blank" rel="noreferrer">
                  Descargar evidencia
                </a>{' '}
                <span className="text-muted-foreground">(caduca en 5 minutos)</span>
              </p>
            ) : null}
            {download.failure !== null ? <p className="text-xs text-red-700">{download.failure}</p> : null}
          </div>
        ) : null}
        {phase.step === 'failed' ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-red-700">
              {phase.code}: {phase.message}
            </p>
            <div>
              <Button variant="ghost" size="sm" onClick={() => inputRef.current?.click()}>
                Reintentar
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
