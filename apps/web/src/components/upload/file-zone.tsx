import { CircleCheck, FileAudio, TriangleAlert, UploadCloud, X } from 'lucide-react';
import { type DragEvent, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { formatBytes } from '@/lib/format';
import { cn } from 'cn';
import { FormatChips, SIZE_LIMIT_COPY } from './panels';
import { FAMILY_LABEL, type Family } from './sniff';

export function DropZone({
  disabled,
  hintId,
  onFile,
  onBrowse,
}: {
  disabled: boolean;
  hintId: string;
  onFile: (file: File | undefined) => void;
  onBrowse: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  // Enter/leave fire for every nested element; a counter keeps the highlight from flickering.
  const depth = useRef(0);
  const end = () => {
    depth.current = 0;
    setDragging(false);
  };
  return (
    <div
      onDragEnter={() => {
        depth.current += 1;
        if (!disabled) setDragging(true);
      }}
      onDragOver={(e: DragEvent) => e.preventDefault()}
      onDragLeave={() => {
        depth.current -= 1;
        if (depth.current <= 0) end();
      }}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        end();
        if (!disabled) onFile(e.dataTransfer.files[0]);
      }}
      className={cn(
        'grid justify-items-center gap-4 rounded-xl border border-dashed px-4 py-10 text-center transition-colors duration-(--duration-base) sm:px-8',
        dragging ? 'border-primary bg-primary/5' : 'bg-muted/30',
      )}
    >
      <span className="bg-primary/10 text-primary grid size-12 place-items-center rounded-xl">
        <UploadCloud aria-hidden className="size-6" />
      </span>
      <div className="grid gap-1">
        <p className="text-base font-medium">Drag and drop an audio file</p>
        <p id={hintId} className="text-muted-foreground text-xs">
          Dragging is optional. One file at a time.
        </p>
      </div>
      <div className="text-muted-foreground flex w-full max-w-48 items-center gap-3 text-xs">
        <span className="bg-border h-px flex-1" />
        or
        <span className="bg-border h-px flex-1" />
      </div>
      <Button onClick={onBrowse} disabled={disabled}>
        Choose file
      </Button>
      <FormatChips />
      <p className="text-muted-foreground max-w-sm text-xs text-pretty">{SIZE_LIMIT_COPY}</p>
    </div>
  );
}

export function FileCard({
  file,
  extension,
  detected,
  mismatchText,
  duplicate,
  busy,
  onReplace,
  onRemove,
}: {
  file: File;
  extension: string;
  detected: Family | null | 'checking';
  mismatchText: string | null;
  duplicate: boolean;
  busy: boolean;
  onReplace: () => void;
  onRemove: () => void;
}) {
  const format =
    detected === 'checking'
      ? 'Checking…'
      : detected
        ? `${FAMILY_LABEL[detected]} (from file contents)`
        : 'Not recognised';
  const status = mismatchText ? (
    <p className="text-destructive flex items-start gap-1.5 text-sm">
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      {mismatchText}
    </p>
  ) : detected === null ? (
    <p className="text-warning flex items-start gap-1.5 text-sm">
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      Content signature not recognised — the server will verify it.
    </p>
  ) : (
    <p className="text-success flex items-start gap-1.5 text-sm">
      <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
      Ready to upload
    </p>
  );
  return (
    <div className="grid gap-3 rounded-xl border p-4">
      <div className="flex items-start gap-3">
        <span className="bg-muted text-muted-foreground grid size-10 shrink-0 place-items-center rounded-lg">
          <FileAudio aria-hidden className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={file.name}>
            {file.name}
          </p>
          <p className="text-muted-foreground text-xs tabular-nums">
            {extension} · {format} · {formatBytes(file.size)}
          </p>
        </div>
        {!busy ? (
          <Button variant="ghost" size="icon-sm" aria-label="Remove file" onClick={onRemove}>
            <X aria-hidden />
          </Button>
        ) : null}
      </div>
      <div role="status" className="grid gap-1.5">
        {detected === 'checking' ? null : status}
        {duplicate ? (
          <p className="text-muted-foreground text-xs">You just uploaded this file.</p>
        ) : null}
      </div>
      {!busy ? (
        <div>
          <Button variant="outline" size="sm" onClick={onReplace}>
            Replace file
          </Button>
        </div>
      ) : null}
    </div>
  );
}
