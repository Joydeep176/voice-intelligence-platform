import {
  DEV_CONSENT_STATEMENT_VERSION,
  type AudioMimeType,
  type RecordingMetadata,
} from '@vip/contracts';
import { api } from './api';

export interface UploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  partsDone: number;
  totalParts: number;
}

export interface UploadOptions {
  mimeType: AudioMimeType;
  onCreated?: (recordingId: string) => void;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}

/**
 * Chunked upload (API §2): create the recording with consent, send each part as a Blob slice
 * (the file is never read into memory whole), then complete. Parts the server already has are
 * skipped, so calling `resumeUpload` after an interruption continues where it stopped.
 */
export async function uploadRecording(file: File, opts: UploadOptions): Promise<RecordingMetadata> {
  const created = await api.createRecording(
    {
      filename: file.name,
      mimeType: opts.mimeType,
      sizeBytes: file.size,
      consent: { statementVersion: DEV_CONSENT_STATEMENT_VERSION, attested: true },
    },
    opts.signal,
  );
  opts.onCreated?.(created.recording.id);
  return sendParts(file, created.recording.id, created.upload, opts);
}

export async function resumeUpload(
  file: File,
  recordingId: string,
  opts: Omit<UploadOptions, 'mimeType' | 'onCreated'>,
): Promise<RecordingMetadata> {
  const session = await api.getUploadSession(recordingId, opts.signal);
  return sendParts(file, recordingId, session, opts);
}

async function sendParts(
  file: File,
  recordingId: string,
  session: { partSize: number; totalParts: number; partsReceived: { partNumber: number }[] },
  opts: Omit<UploadOptions, 'mimeType' | 'onCreated'>,
): Promise<RecordingMetadata> {
  const received = new Set(session.partsReceived.map((p) => p.partNumber));
  const sizeOf = (n: number) => Math.min(session.partSize, file.size - (n - 1) * session.partSize);
  let uploadedBytes = [...received].reduce((sum, n) => sum + sizeOf(n), 0);
  let partsDone = received.size;
  const report = () =>
    opts.onProgress?.({
      uploadedBytes,
      totalBytes: file.size,
      partsDone,
      totalParts: session.totalParts,
    });
  report();

  for (let n = 1; n <= session.totalParts; n++) {
    if (received.has(n)) continue;
    opts.signal?.throwIfAborted();
    const start = (n - 1) * session.partSize;
    await api.uploadPart(recordingId, n, file.slice(start, start + session.partSize), opts.signal);
    uploadedBytes += sizeOf(n);
    partsDone += 1;
    report();
  }
  return api.completeUpload(recordingId, opts.signal);
}
