import {
  type AudioMimeType,
  DEV_CONSENT_STATEMENT,
  DEV_CONSENT_STATEMENT_VERSION,
  type RecordingMetadata,
  SUPPORTED_AUDIO_MIME_TYPES,
} from '@vip/contracts';
import { CheckCircle2, FileAudio, RotateCcw, UploadCloud, X } from 'lucide-react';
import { type ChangeEvent, type DragEvent, useId, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { PageHeader } from '@/components/states';
import { useToast } from '@/components/toaster';
import { describeError } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { Link } from '@/lib/router';
import { resumeUpload, type UploadProgress, uploadRecording } from '@/lib/upload';
import { cn } from 'cn';

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
  | { name: 'uploading'; progress: UploadProgress | null }
  | { name: 'failed'; message: string }
  | { name: 'done'; recording: RecordingMetadata };

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const [dragging, setDragging] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const lastAnnounced = useRef(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const { notify } = useToast();
  const ids = { input: useId(), consent: useId(), hint: useId() };

  const choose = (selected: File | undefined) => {
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
  };

  const onProgress = (p: UploadProgress) => {
    setPhase({ name: 'uploading', progress: p });
    // Announce in 25% steps only, so screen readers are not flooded (accessibility.md).
    const quarter = Math.floor((p.uploadedBytes / p.totalBytes) * 4);
    if (quarter !== lastAnnounced.current) {
      lastAnnounced.current = quarter;
      setAnnouncement(`Upload ${quarter * 25}% complete`);
    }
  };

  const start = async (resume: boolean) => {
    if (!file || !consent) return;
    const mimeType = resolveMimeType(file);
    if (!mimeType) return;
    controller.current = new AbortController();
    lastAnnounced.current = -1;
    setPhase({ name: 'uploading', progress: null });
    try {
      const signal = controller.current.signal;
      const recording =
        resume && recordingId
          ? await resumeUpload(file, recordingId, { onProgress, signal })
          : await uploadRecording(file, {
              mimeType,
              onProgress,
              signal,
              onCreated: setRecordingId,
            });
      setPhase({ name: 'done', recording });
      setAnnouncement('Upload complete');
      notify({
        tone: 'success',
        title: 'Upload complete',
        description: 'The recording is stored. Analysis is not available yet.',
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        setPhase({ name: 'failed', message: 'Upload cancelled. You can resume it.' });
        return;
      }
      const message = describeError(error);
      setPhase({ name: 'failed', message });
      notify({ tone: 'error', title: 'Upload failed', description: message });
    }
  };

  const reset = () => {
    setFile(null);
    setConsent(false);
    setPhase({ name: 'idle' });
    setRecordingId(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const busy = phase.name === 'uploading';
  const percent =
    phase.name === 'uploading' && phase.progress
      ? Math.round((phase.progress.uploadedBytes / phase.progress.totalBytes) * 100)
      : 0;

  if (phase.name === 'done') {
    return (
      <div className="mx-auto grid max-w-2xl gap-6">
        <PageHeader title="Upload recording" />
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="flex items-center gap-2">
                <CheckCircle2 aria-hidden className="text-success size-5" />
                Upload complete
              </h2>
            </CardTitle>
            <CardDescription>
              <strong className="text-foreground font-medium">
                {phase.recording.originalFilename}
              </strong>{' '}
              is stored and a processing run has been recorded. It has not been transcribed or
              analysed: those steps are not available yet.
            </CardDescription>
          </CardHeader>
          <CardFooter className="flex flex-wrap gap-2">
            <Button asChild>
              <Link to={`/recordings/${phase.recording.id}`}>View recording</Link>
            </Button>
            <Button variant="outline" onClick={reset}>
              Upload another
            </Button>
          </CardFooter>
        </Card>
        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto grid max-w-2xl gap-6">
      <PageHeader
        title="Upload recording"
        description="Files are sent in parts and can be resumed if the connection drops."
      />
      <Card>
        <CardHeader>
          <CardTitle>Audio file</CardTitle>
          <CardDescription>
            WAV, MP3, M4A, FLAC, OGG or WebM. Server size limits apply.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div
            onDragOver={(e: DragEvent) => {
              e.preventDefault();
              if (!busy) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e: DragEvent) => {
              e.preventDefault();
              setDragging(false);
              if (!busy) choose(e.dataTransfer.files[0]);
            }}
            className={cn(
              'grid place-items-center gap-3 rounded-xl border border-dashed p-8 text-center transition-colors duration-(--duration-base)',
              dragging ? 'border-primary bg-primary/5' : 'bg-muted/30',
            )}
          >
            <UploadCloud aria-hidden className="text-muted-foreground size-8" />
            <div className="grid gap-1">
              <p className="text-sm font-medium">Drag and drop an audio file, or</p>
              <p id={ids.hint} className="text-muted-foreground text-xs">
                One file at a time
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
            >
              Choose file
            </Button>
            <input
              ref={inputRef}
              id={ids.input}
              type="file"
              accept={[...SUPPORTED_AUDIO_MIME_TYPES, '.wav,.mp3,.m4a,.flac,.ogg,.webm'].join(',')}
              aria-label="Audio file"
              aria-describedby={ids.hint}
              className="sr-only"
              onChange={(e: ChangeEvent<HTMLInputElement>) => choose(e.target.files?.[0])}
              disabled={busy}
            />
          </div>

          {fileError ? (
            <p role="alert" className="text-destructive text-sm">
              {fileError}
            </p>
          ) : null}

          {file ? (
            <div className="flex items-center gap-3 rounded-lg border p-3">
              <FileAudio aria-hidden className="text-muted-foreground size-5 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{file.name}</p>
                <p className="text-muted-foreground text-xs tabular-nums">
                  {formatBytes(file.size)}
                </p>
              </div>
              {!busy ? (
                <Button variant="ghost" size="icon-sm" aria-label="Remove file" onClick={reset}>
                  <X aria-hidden />
                </Button>
              ) : null}
            </div>
          ) : null}

          <div className="flex items-start gap-3 rounded-lg border p-3">
            <Checkbox
              id={ids.consent}
              checked={consent}
              onCheckedChange={(v) => setConsent(v === true)}
              disabled={busy}
              className="mt-0.5"
            />
            <div className="grid gap-1">
              <Label htmlFor={ids.consent} className="leading-snug font-normal">
                {DEV_CONSENT_STATEMENT}
              </Label>
              <p className="text-muted-foreground text-xs">
                Development consent statement {DEV_CONSENT_STATEMENT_VERSION}. Production wording is
                not yet defined.
              </p>
            </div>
          </div>

          {phase.name === 'uploading' ? (
            <div className="grid gap-2">
              <div className="flex justify-between text-sm">
                <span>Uploading…</span>
                <span className="tabular-nums">{percent}%</span>
              </div>
              <Progress value={percent} aria-label="Upload progress" />
              {phase.progress ? (
                <p className="text-muted-foreground text-xs tabular-nums">
                  {formatBytes(phase.progress.uploadedBytes)} of{' '}
                  {formatBytes(phase.progress.totalBytes)} · part {phase.progress.partsDone} of{' '}
                  {phase.progress.totalParts}
                </p>
              ) : null}
            </div>
          ) : null}

          {phase.name === 'failed' ? (
            <Alert variant="destructive">
              <AlertTitle>Upload stopped</AlertTitle>
              <AlertDescription>{phase.message}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
        <CardFooter className="flex flex-wrap justify-end gap-2">
          {busy ? (
            <Button variant="outline" onClick={() => controller.current?.abort()}>
              Cancel
            </Button>
          ) : null}
          {phase.name === 'failed' && recordingId ? (
            <Button variant="outline" onClick={() => void start(true)} disabled={!file || !consent}>
              <RotateCcw aria-hidden data-icon="inline-start" />
              Resume upload
            </Button>
          ) : null}
          {!busy ? (
            <Button onClick={() => void start(false)} disabled={!file || !consent}>
              <UploadCloud aria-hidden data-icon="inline-start" />
              {phase.name === 'failed' ? 'Start again' : 'Upload'}
            </Button>
          ) : null}
        </CardFooter>
      </Card>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
