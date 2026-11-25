import { SpeakerPatch, type SpeakerDto } from '@vip/contracts';
import { Loader2, Pencil } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatTimestamp } from './model';

function SpeakerRow({
  speaker,
  rename,
  onRenamed,
}: {
  speaker: SpeakerDto;
  rename: (id: string, name: string) => Promise<{ error: string | null }>;
  onRenamed: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      buttonRef.current?.focus();
    }
  }, [editing]);

  const open = () => {
    setValue(speaker.displayName ?? '');
    setError(null);
    setEditing(true);
  };
  const close = () => {
    returnFocus.current = true;
    setEditing(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = SpeakerPatch.safeParse({ displayName: value });
    if (!parsed.success) {
      setError('Enter a name of 1 to 80 characters.');
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const result = await rename(speaker.id, parsed.data.displayName);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      inputRef.current?.focus();
      return;
    }
    onRenamed(parsed.data.displayName);
    close();
  };

  const inputId = `speaker-name-${speaker.id}`;
  const errorId = `${inputId}-error`;
  return (
    <li className="grid gap-2 rounded-md border p-3" data-testid="speaker-row">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {speaker.displayName ?? <span className="text-muted-foreground">No display name</span>}
          </p>
          <p className="text-muted-foreground text-xs">
            Speaker key: <code className="font-mono">{speaker.speakerKey}</code>
            <span aria-hidden> · </span>
            <span className="tabular-nums">Speech {formatTimestamp(speaker.totalSpeechMs)}</span>
          </p>
        </div>
        {editing ? null : (
          <Button
            ref={buttonRef}
            variant="outline"
            size="sm"
            onClick={open}
            aria-label={`Rename ${speaker.displayName ?? speaker.speakerKey}`}
          >
            <Pencil aria-hidden data-icon="inline-start" />
            Rename
          </Button>
        )}
      </div>
      {editing ? (
        <form onSubmit={(e) => void submit(e)} className="grid gap-2" noValidate>
          <label htmlFor={inputId} className="text-muted-foreground text-xs">
            Display name for {speaker.speakerKey}
          </label>
          <div className="flex flex-wrap gap-2">
            <Input
              id={inputId}
              ref={inputRef}
              value={value}
              maxLength={80}
              disabled={busy}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') close();
              }}
              className="min-w-0 flex-1 basis-48"
            />
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? (
                <Loader2
                  aria-hidden
                  className="motion-safe:animate-spin"
                  data-icon="inline-start"
                />
              ) : null}
              Save
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={close}>
              Cancel
            </Button>
          </div>
          {error ? (
            <p id={errorId} role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
    </li>
  );
}

export function SpeakersPanel({
  speakers,
  rename,
  announce,
}: {
  speakers: SpeakerDto[];
  rename: (id: string, name: string) => Promise<{ error: string | null }>;
  announce: (message: string) => void;
}) {
  if (speakers.length === 0) {
    return <p className="text-muted-foreground text-sm">No speakers were identified.</p>;
  }
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {speakers.map((s) => (
        <SpeakerRow
          key={s.id}
          speaker={s}
          rename={rename}
          onRenamed={(name) => announce(`Renamed ${s.speakerKey} to ${name}`)}
        />
      ))}
    </ul>
  );
}
