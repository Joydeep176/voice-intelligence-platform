import {
  type AudioMimeType,
  type RecordingMetadata,
  SUPPORTED_AUDIO_MIME_TYPES,
  type UploadSession,
} from '@vip/contracts';
import { CheckCircle2, RotateCcw, UploadCloud } from 'lucide-react';
import { type ChangeEvent, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { DropZone, FileCard } from '@/components/upload/file-zone';
import { ConsentBlock, FailureNotice, InfoRail, ProgressPanel } from '@/components/upload/panels';
import { FAMILY_LABEL, type Family, familyOf, sniffFile } from '@/components/upload/sniff';
import { PageHeader } from '@/components/states';
import { useToast } from '@/components/toaster';
import { api, ApiRequestError, describeError } from '@/lib/api';
import { formatBytes, formatDateTime } from '@/lib/format';
import { Link } from '@/lib/router';
import { resumeUpload, type UploadProgress, uploadRecording } from '@/lib/upload';

const BY_EXTENSION: Record<string, AudioMimeType> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  webm: 'audio/webm',
};

/** Resolves a supported MIME type from the browser's type or, failing that, the extension. */
export function resolveMimeType(file: Pick<File, 'name' | 'type'>): AudioMimeType | null {
  if ((SUPPORTED_AUDIO_MIME_TYPES as readonly string[]).includes(file.type))
    return file.type as AudioMimeType;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return BY_EXTENSION[ext] ?? null;
}

type Phase =
  | { name: 'idle' }
  | { name: 'uploading'; progress: UploadProgress | null; resumed: number | null }
  | { name: 'failed'; message: string; code: string }
  | { name: 'done'; recording: RecordingMetadata };

type Sniff = 'checking' | Family | null;

const fileKey = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;

/** Title and next step per failure; the message itself always comes from describeError. */
function failureCopy(code: string): { title: string; hint: string } {
  switch (code) {
    case 'CANCELLED':
      return {
        title: 'Upload cancelled',
        hint: 'Parts already sent are kept on the server for its session lifetime, so you can resume.',
      };
    case 'NETWORK_ERROR':
      return {
        title: 'Upload interrupted',
        hint: 'Check your connection, then resume. Parts already sent are kept on the server for its session lifetime.',
      };
    case 'UPLOAD_EXPIRED':
      return { title: 'Upload expired', hint: 'Start again.' };
    case 'MEDIA_SIGNATURE_MISMATCH':
      return {
        title: 'File rejected',
        hint: 'The recording was rejected and kept as invalid; choose a correctly formatted file.',
      };
    case 'PAYLOAD_TOO_LARGE':
      return { title: 'File too large', hint: 'Choose a smaller file.' };
    case 'CLIENT_MISMATCH':
      return { title: 'File not uploaded', hint: 'Choose a correctly formatted file.' };
    default:
      return { title: 'Upload stopped', hint: 'Resume if you can, or start again.' };
  }
}

const NOT_RESUMABLE = new Set([
  'UPLOAD_EXPIRED',
  'MEDIA_SIGNATURE_MISMATCH',
  'PAYLOAD_TOO_LARGE',
  'CLIENT_MISMATCH',
]);

/** What the server says about the interrupted session; 'unknown' means the check itself failed. */
type Saved = 'checking' | 'unknown' | UploadSession | null;

function interruptedCopy(code: string, saved: UploadSession | 'unknown') {
  if (saved === 'unknown')
    return {
      title: 'Upload interrupted',
      message:
        "The connection dropped before the upload finished, and we couldn't check which parts were saved. Check your connection, then try resuming. If that fails, start again.",
      hint: null,
    };
  if (saved.status === 'expired' || saved.status === 'aborted')
    return {
      title: 'Upload expired',
      message: 'The saved parts are no longer available. Start the upload again.',
      hint: null,
    };
  const done = saved.status === 'completed';
  return {
    title: code === 'CANCELLED' ? 'Upload cancelled' : 'Upload paused',
    message: done
      ? 'All parts are saved on the server. Resume to finish the upload.'
      : `The connection was interrupted before the upload finished. ${saved.partsReceived.length} of ${saved.totalParts} parts are saved on the server. Resume to send the rest. Saved parts won't be sent again.`,
    hint: done ? null : (
      <span>
        You can resume until {formatDateTime(saved.expiresAt)} while this page stays open.
      </span>
    ),
  };
}

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const [announcement, setAnnouncement] = useState('');
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [sniff, setSniff] = useState<Sniff>('checking');
  const [duplicate, setDuplicate] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const lastAnnounced = useRef(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const sniffed = useRef<Promise<Family | null>>(Promise.resolve(null));
  const completed = useRef<string | null>(null);
  const [saved, setSaved] = useState<Saved>(null);
  const checking = useRef<AbortController | null>(null);
  const { notify } = useToast();
  const ids = { input: useId(), consent: useId(), hint: useId() };

  const notifySaved = (code: string, saved: UploadSession | 'unknown') => {
    const { title } = interruptedCopy(code, saved);
    const lapsed =
      saved !== 'unknown' && (saved.status === 'expired' || saved.status === 'aborted');
    const description =
      saved === 'unknown'
        ? "We couldn't confirm which parts were saved. Check your connection, then try resuming."
        : lapsed
          ? 'Start the upload again.'
          : saved.status === 'completed'
            ? 'All parts are saved. Resume to finish the upload.'
            : `${saved.partsReceived.length} of ${saved.totalParts} parts are saved. You can resume while this page stays open.`;
    notify({ tone: lapsed ? 'error' : 'info', title, description });
  };

  const stopCheck = () => {
    checking.current?.abort();
    checking.current = null;
  };
  useEffect(() => stopCheck, []);

  const checkSaved = async (id: string, code: string) => {
    stopCheck();
    const ctl = new AbortController();
    checking.current = ctl;
    setSaved('checking');
    try {
      const session = await api.getUploadSession(id, ctl.signal);
      if (ctl.signal.aborted) return;
      setSaved(session);
      notifySaved(code, session);
    } catch {
      if (ctl.signal.aborted) return;
      setSaved('unknown');
      notifySaved(code, 'unknown');
    }
  };

  const choose = (selected: File | undefined) => {
    stopCheck();
    setSaved(null);
    setPhase({ name: 'idle' });
    setRecordingId(null);
    if (!selected) return;
    if (!resolveMimeType(selected)) {
      setFile(null);
      setFileError('Unsupported file type. Use WAV, MP3, M4A, FLAC, OGG or WebM audio.');
      return;
    }
    if (selected.size === 0) {
      setFile(null);
      setFileError('This file is empty.');
      return;
    }
    setFileError(null);
    setFile(selected);
    setDuplicate(completed.current === fileKey(selected));
    setSniff('checking');
    const result = sniffFile(selected);
    sniffed.current = result;
    void result.then((family) => {
      if (sniffed.current === result) setSniff(family);
    });
  };

  const mismatchOf = (family: Family | null | 'checking', f: File | null) => {
    const mime = f ? resolveMimeType(f) : null;
    if (!mime || !family || family === 'checking' || family === familyOf(mime)) return null;
    return `Content looks like ${FAMILY_LABEL[family]} but the file is declared as ${FAMILY_LABEL[familyOf(mime)]}. Rename it with the right extension or choose another file.`;
  };

  const start = async (resume: boolean) => {
    if (!file || !consent) return;
    const mimeType = resolveMimeType(file);
    if (!mimeType) return;
    const mismatch = mismatchOf(await sniffed.current, file);
    if (mismatch) {
      setPhase({ name: 'failed', message: mismatch, code: 'CLIENT_MISMATCH' });
      return;
    }
    stopCheck();
    setSaved(null);
    controller.current = new AbortController();
    let activeId = resume ? recordingId : null;
    lastAnnounced.current = -1;
    let first = true;
    let resumed: number | null = null;
    const onProgress = (p: UploadProgress) => {
      if (resume && first && p.partsDone > 0) resumed = p.partsDone;
      first = false;
      setPhase({ name: 'uploading', progress: p, resumed });
      // Announce in 25% steps and on the finalising stage only (accessibility.md).
      const quarter = Math.floor((p.uploadedBytes / p.totalBytes) * 4);
      if (quarter !== lastAnnounced.current) {
        lastAnnounced.current = quarter;
        setAnnouncement(`Upload ${quarter * 25}% complete`);
      } else if (p.partsDone === p.totalParts && lastAnnounced.current !== 5) {
        lastAnnounced.current = 5;
        setAnnouncement('Finalising upload');
      }
    };
    setPhase({ name: 'uploading', progress: null, resumed: null });
    setAnnouncement('Creating upload');
    try {
      const signal = controller.current.signal;
      const recording =
        resume && recordingId
          ? await resumeUpload(file, recordingId, { onProgress, signal })
          : await uploadRecording(file, {
              mimeType,
              onProgress,
              signal,
              onCreated: (id) => {
                activeId = id;
                setRecordingId(id);
              },
            });
      completed.current = fileKey(file);
      setPhase({ name: 'done', recording });
      setAnnouncement('Upload complete');
      notify({
        tone: 'success',
        title: 'Upload complete',
        description: 'The recording is stored. Analysis is not available yet.',
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        setPhase({
          name: 'failed',
          message: 'Upload cancelled. You can resume it.',
          code: 'CANCELLED',
        });
        if (activeId) void checkSaved(activeId, 'CANCELLED');
        return;
      }
      const message = describeError(error);
      const code = error instanceof ApiRequestError ? error.code : 'UNKNOWN';
      setPhase({ name: 'failed', message, code });
      if (activeId && !NOT_RESUMABLE.has(code)) void checkSaved(activeId, code);
      else notify({ tone: 'error', title: failureCopy(code).title, description: message });
    }
  };

  const reset = () => {
    stopCheck();
    setSaved(null);
    setFile(null);
    setConsent(false);
    setDuplicate(false);
    setPhase({ name: 'idle' });
    setRecordingId(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const busy = phase.name === 'uploading';
  const mismatch = mismatchOf(sniff, file);
  const browse = () => inputRef.current?.click();

  const input = (
    <input
      ref={inputRef}
      id={ids.input}
      type="file"
      accept={[...SUPPORTED_AUDIO_MIME_TYPES, '.wav,.mp3,.m4a,.flac,.ogg,.webm'].join(',')}
      aria-label="Audio file"
      aria-describedby={file ? undefined : ids.hint}
      className="sr-only"
      onChange={(e: ChangeEvent<HTMLInputElement>) => choose(e.target.files?.[0])}
      disabled={busy}
    />
  );
  const live = (
    <p aria-live="polite" className="sr-only">
      {announcement}
    </p>
  );

  if (phase.name === 'done') {
    const { recording } = phase;
    return (
      <div className="grid gap-6">
        <PageHeader title="Upload recording" />
        <div className="grid items-start gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardContent className="grid gap-3">
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <CheckCircle2 aria-hidden className="text-success size-5" />
                Upload complete
              </h2>
              <p className="text-muted-foreground text-sm">
                <strong className="text-foreground font-medium break-all">
                  {recording.originalFilename}
                </strong>{' '}
                ({formatBytes(recording.sizeBytes)}) is stored and a processing run has been
                recorded. It has not been transcribed or analysed: those steps are not available
                yet.
              </p>
            </CardContent>
            <CardFooter className="flex flex-wrap gap-2">
              <Button asChild>
                <Link to={`/recordings/${recording.id}`}>View recording</Link>
              </Button>
              <Button variant="outline" onClick={reset}>
                Upload another
              </Button>
              <Button variant="ghost" asChild>
                <Link to="/recordings">Go to recordings</Link>
              </Button>
            </CardFooter>
          </Card>
          <InfoRail />
        </div>
        {input}
        {live}
      </div>
    );
  }

  const failed = phase.name === 'failed' ? phase : null;
  const resumable = !!failed && !!recordingId && !NOT_RESUMABLE.has(failed.code);
  const session = resumable && saved !== 'checking' ? saved : null;
  const confirmed =
    !!session &&
    session !== 'unknown' &&
    session.status !== 'expired' &&
    session.status !== 'aborted';
  const lapsed = !!session && session !== 'unknown' && !confirmed;
  const copy = failed
    ? session
      ? interruptedCopy(failed.code, session)
      : { ...failureCopy(failed.code), message: failed.message }
    : null;
  return (
    <div className="grid gap-6">
      <PageHeader
        title="Upload recording"
        description="Add a synthetic or consented recording. Files upload in parts and can resume if the connection drops."
      />
      <div className="grid items-start gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="grid gap-5">
            {file ? (
              <FileCard
                file={file}
                extension={`.${file.name.split('.').pop()?.toLowerCase() ?? ''}`}
                detected={sniff}
                mismatchText={mismatch}
                duplicate={duplicate}
                busy={busy}
                onReplace={browse}
                onRemove={reset}
              />
            ) : (
              <DropZone disabled={busy} hintId={ids.hint} onFile={choose} onBrowse={browse} />
            )}
            {input}

            {fileError ? (
              <p role="alert" className="text-destructive text-sm">
                {fileError}{' '}
                {fileError === 'This file is empty.'
                  ? 'Choose a recording that contains audio.'
                  : ''}
              </p>
            ) : null}

            <ConsentBlock
              id={ids.consent}
              checked={consent}
              disabled={busy}
              onChange={setConsent}
            />

            {phase.name === 'uploading' ? (
              <ProgressPanel progress={phase.progress} resumed={phase.resumed} />
            ) : null}

            {resumable && saved === 'checking' ? (
              <p role="status" className="text-muted-foreground text-sm">
                Checking what was saved…
              </p>
            ) : failed && copy ? (
              <FailureNotice
                title={copy.title}
                message={copy.message}
                hint={copy.hint}
                warning={!!session && !lapsed}
              />
            ) : null}
          </CardContent>
          <CardFooter className="flex flex-wrap justify-end gap-2">
            {busy ? (
              <Button variant="outline" onClick={() => controller.current?.abort()}>
                Cancel
              </Button>
            ) : null}
            {resumable && saved !== 'checking' && !lapsed ? (
              <Button
                variant={confirmed ? 'default' : 'outline'}
                onClick={() => void start(true)}
                disabled={!file || !consent}
              >
                <RotateCcw aria-hidden data-icon="inline-start" />
                Resume upload
              </Button>
            ) : null}
            {!busy ? (
              <Button
                variant={confirmed ? 'outline' : 'default'}
                onClick={() => void start(false)}
                disabled={!file || !consent || !!mismatch}
              >
                <UploadCloud aria-hidden data-icon="inline-start" />
                {failed ? 'Start again' : 'Upload'}
              </Button>
            ) : null}
          </CardFooter>
        </Card>
        <InfoRail />
      </div>
      {live}
    </div>
  );
}
