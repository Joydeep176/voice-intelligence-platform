import { CircleSlash } from 'lucide-react';
import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { RunStatusBadge } from '@/components/status-badge';
import { ApiRequestError, api } from '@/lib/api';
import { Link } from '@/lib/router';
import { useAsync } from '@/lib/use-async';

const panel =
  'bg-card ring-foreground/10 grid gap-2 rounded-xl p-4 text-sm shadow-sm ring-1 sm:grid-cols-[minmax(0,1fr)_auto]';

/** Real run state for one recording. The run snapshot is all there is: no agent-level data exists. */
export function RunContext({ id, onClear }: { id: string; onClear: () => void }) {
  const state = useAsync((signal) => api.getRecording(id, signal), [id]);
  if (state.status === 'loading') return <LoadingRows rows={1} label="Loading recording" />;
  if (state.status === 'error') {
    if (state.error instanceof ApiRequestError && state.error.status === 404) {
      return (
        <EmptyState
          icon={<CircleSlash aria-hidden />}
          title="Recording not found"
          description="It may have been removed, or it belongs to another workspace."
          action={
            <Button variant="outline" size="sm" onClick={onClear}>
              Show the pipeline without a recording
            </Button>
          }
        />
      );
    }
    return <ErrorState error={state.error} onRetry={state.reload} />;
  }
  const r = state.data;
  return (
    <section aria-label="Recording context" className={panel}>
      <div className="grid min-w-0 gap-1.5">
        <p className="flex min-w-0 items-center gap-2 font-medium">
          <Link
            to={`/recordings/${r.id}`}
            className="focus-visible:ring-ring/50 min-w-0 truncate rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-3"
          >
            {r.originalFilename}
          </Link>
        </p>
        <p className="text-muted-foreground max-w-prose text-sm">
          {r.latestRun?.status === 'created'
            ? 'This run has been recorded but not submitted. Agents do not execute in this build, so no agent-level status exists.'
            : r.latestRun
              ? 'Agents do not execute in this build, so no agent-level status exists.'
              : 'No run has been recorded for this recording yet. Agents do not execute in this build.'}
        </p>
      </div>
      <div className="flex items-start gap-2 sm:justify-end">
        <span className="text-muted-foreground text-xs">Run</span>
        {r.latestRun ? <RunStatusBadge status={r.latestRun.status} /> : null}
        <Button variant="ghost" size="xs" onClick={onClear}>
          Clear
        </Button>
      </div>
    </section>
  );
}

/** Optional picker shown when no recording is selected. */
export function RecordingPicker({ onPick }: { onPick: (id: string) => void }) {
  const selectId = useId();
  const state = useAsync((signal) => api.listRecordings({ limit: 25 }, signal), []);
  if (state.status === 'loading') return <LoadingRows rows={1} label="Loading recordings" />;
  if (state.status === 'error') {
    return (
      <ErrorState error={state.error} onRetry={state.reload} title="Could not load recordings" />
    );
  }
  const items = state.data.items;
  if (items.length === 0) return null;
  return (
    <div className={panel}>
      <div className="grid gap-1.5">
        <label htmlFor={selectId} className="flex items-center gap-2 font-medium">
          Inspect a recording&rsquo;s run
        </label>
        <select
          id={selectId}
          defaultValue=""
          onChange={(e) => e.target.value && onPick(e.target.value)}
          className="border-input bg-background focus-visible:ring-ring/50 h-9 w-full max-w-md rounded-lg border px-2 text-sm outline-none focus-visible:ring-3"
        >
          <option value="">Choose a recording</option>
          {items.map((r) => (
            <option key={r.id} value={r.id}>
              {r.originalFilename}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
