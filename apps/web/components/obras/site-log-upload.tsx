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
 * Photo upload for the site log (H2, bases §4.5).
 *
 * The log panel degrades photos to metadata UUIDs because MVP1 had no upload
 * endpoint; this panel closes that gap for one photo at a time: it mints a
 * signed PUT through the API proxy, uploads the bytes straight to the object
 * store, and hands the `attachmentId` back through `onAttached` so the log
 * form can record a real identifier instead of a hand-typed one.
 *
 * No permanent URL is ever rendered: the download leg mints a GET URL valid
 * for at most 5 minutes, and the link it produces says so.
 */
export interface SiteLogUploadProps {
  /** `attendance.mark` — without it the panel explains instead of offering. */
  readonly canMark: boolean;
  /** Receives the registered `attachments` id after a successful PUT. */
  readonly onAttached?: (attachmentId: string) => void;
  readonly className?: string;
}

type Phase =
  | { readonly step: 'idle' }
  | { readonly step: 'requesting' }
  | { readonly step: 'uploading'; readonly grant: FileUploadResponse }
  | { readonly step: 'done'; readonly grant: FileUploadResponse }
  | { readonly step: 'failed'; readonly code: string; readonly message: string };

interface DownloadState {
  readonly loading: boolean;
  readonly grant: FileDownloadResponse | null;
  readonly failure: string | null;
}

const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';

function readEnvelope(payload: unknown): { code: string; message: string } {
  if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>;
    const code = typeof record.code === 'string' ? record.code : 'upload.failed';
    const message = typeof record.message === 'string' ? record.message : 'La carga falló.';
    return { code, message };
  }
  return { code: 'upload.failed', message: 'La carga falló.' };
}

export function SiteLogUpload({ canMark, onAttached, className }: SiteLogUploadProps) {
  const [phase, setPhase] = useState<Phase>({ step: 'idle' });
  const [fileName, setFileName] = useState<string | null>(null);
  const [download, setDownload] = useState<DownloadState>({ loading: false, grant: null, failure: null });
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function handleFile(file: File): Promise<void> {
    setFileName(file.name);
    setDownload({ loading: false, grant: null, failure: null });
    if (file.size > FILE_SIZE_LIMIT_BYTES) {
      setPhase({ step: 'failed', code: 'validation.failed', message: 'La foto supera los 25 MiB.' });
      return;
    }
    const mime = file.type === '' ? 'image/jpeg' : file.type;
    const request = fileUploadRequestSchema.safeParse({
      module: 'obras',
      mime,
      sizeBytes: file.size,
    });
    if (!request.success) {
      setPhase({ step: 'failed', code: 'validation.failed', message: 'Tipo de archivo no admitido para la bitácora.' });
      return;
    }
    setPhase({ step: 'requesting' });
    try {
      const grantResponse = await fetch('/api/proxy/files/request-upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.data),
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
        body: file,
      });
      if (!putResponse.ok) {
        setPhase({
          step: 'failed',
          code: 'upload.transport',
          message: `El objeto no aceptó los bytes (${putResponse.status}).`,
        });
        return;
      }
      setPhase({ step: 'done', grant });
      onAttached?.(grant.attachmentId);
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
    <Card className={className} id="foto-bitacora">
      <CardHeader>
        <CardEyebrow>Bitácora</CardEyebrow>
        <CardTitle as="h3">Subir foto de la obra</CardTitle>
        <CardDescription>
          La URL de subida es firmada y de un solo uso efectivo: el registro en{' '}
          <code className="font-mono text-xs">attachments</code> existe antes de subir, y el enlace
          de descarga que se obtiene después caduca en 5 minutos.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!canMark ? (
          <p className="text-xs text-muted-foreground">
            Sin <code className="font-mono">attendance.mark</code>: la subida no se ofrece.
          </p>
        ) : (
          <>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              disabled={busy}
              className="text-xs"
              aria-label="Foto de la bitácora de obra"
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
              Foto subida: <code className="font-mono">{phase.grant.attachmentId}</code>
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
                  Descargar foto
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
