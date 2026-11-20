import { DEV_CONSENT_STATEMENT, DEV_CONSENT_STATEMENT_VERSION } from '@vip/contracts';
import { PauseCircle, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { formatBytes } from '@/lib/format';
import type { UploadProgress } from '@/lib/upload';
import { FORMAT_CHIPS } from './sniff';

export const SIZE_LIMIT_COPY =
  'The size limit is set by the server. Files over the limit are rejected straight away, before any data is sent.';

export function FormatChips() {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Accepted formats">
      {FORMAT_CHIPS.map((f) => (
        <li
          key={f}
          className="bg-muted text-muted-foreground rounded-md px-2 py-0.5 text-xs font-medium"
        >
          {f}
        </li>
      ))}
    </ul>
  );
}

export function ConsentBlock({
  id,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <section className="bg-muted/40 grid gap-3 rounded-xl border p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck aria-hidden className="text-primary size-4" />
        Consent required
      </h3>
      <div className="flex items-start gap-3">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="accent-primary focus-visible:ring-ring/50 mt-0.5 size-5 shrink-0 cursor-pointer rounded focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <div className="grid gap-1">
          <Label htmlFor={id} className="cursor-pointer text-sm leading-snug font-normal">
            {DEV_CONSENT_STATEMENT}
          </Label>
          <p className="text-muted-foreground text-xs">
            Development consent statement {DEV_CONSENT_STATEMENT_VERSION}. Production wording is not
            yet defined.
          </p>
        </div>
      </div>
    </section>
  );
}

export function ProgressPanel({
  progress,
  resumed,
}: {
  progress: UploadProgress | null;
  resumed: number | null;
}) {
  const percent = progress ? Math.round((progress.uploadedBytes / progress.totalBytes) * 100) : 0;
  const stage = !progress
    ? 'Creating upload…'
    : progress.partsDone === progress.totalParts
      ? 'Finalising…'
      : 'Uploading parts…';
  return (
    <section className="grid gap-2.5 rounded-xl border p-4" aria-label="Upload progress">
      <div className="flex justify-between gap-3 text-sm">
        <span className="font-medium">{stage}</span>
        <span className="tabular-nums">{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label="Upload progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="bg-muted h-2 overflow-hidden rounded-full"
      >
        <div
          className="bg-primary h-full w-full origin-left transition-transform duration-(--duration-base) motion-reduce:transition-none"
          style={{ transform: `scaleX(${percent / 100})` }}
        />
      </div>
      {progress ? (
        <p className="text-muted-foreground text-xs tabular-nums">
          {formatBytes(progress.uploadedBytes)} of {formatBytes(progress.totalBytes)} · part{' '}
          {progress.partsDone} of {progress.totalParts}
        </p>
      ) : null}
      {resumed && progress ? (
        <p className="text-muted-foreground text-xs">
          Resuming — {resumed} of {progress.totalParts} parts were already on the server.
        </p>
      ) : null}
      <p className="text-muted-foreground text-xs">
        Progress updates after each part, so small files may jump to 100%.
      </p>
    </section>
  );
}

export function FailureNotice({
  title,
  message,
  hint,
  warning,
}: {
  title: string;
  message: string;
  hint?: ReactNode;
  /** Resumable or unresolved interruption: amber, not a failure. */
  warning?: boolean;
}) {
  return (
    <Alert
      variant={warning ? 'default' : 'destructive'}
      className={warning ? 'bg-warning-soft text-warning border-warning/40' : undefined}
    >
      {warning ? <PauseCircle aria-hidden /> : <TriangleAlert aria-hidden />}
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className={warning ? 'text-warning' : undefined}>
        <p>{message}</p>
        {hint ? <p>{hint}</p> : null}
      </AlertDescription>
    </Alert>
  );
}

export function InfoRail() {
  return (
    <aside aria-label="About uploads" className="grid content-start gap-4">
      <section className="bg-card grid gap-2 rounded-xl border p-4">
        <h2 className="text-sm font-semibold">How uploads work</h2>
        <ul className="text-muted-foreground list-disc space-y-1.5 pl-4 text-sm">
          <li>The file is sent in parts.</li>
          <li>If the connection drops, resume while this page stays open.</li>
          <li>The server checks the format signature when the upload completes.</li>
          <li>Transcription and analysis arrive in later phases.</li>
        </ul>
      </section>
      <section className="bg-card grid gap-2 rounded-xl border p-4">
        <h2 className="text-sm font-semibold">Accepted formats</h2>
        <FormatChips />
      </section>
    </aside>
  );
}
