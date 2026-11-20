import { HealthResponse } from '@vip/contracts';
import { CircleHelp, CircleAlert, CircleCheck, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from 'cn';

type Tone = 'neutral' | 'success' | 'danger';
interface RowState {
  tone: Tone;
  text: string;
}

const TONE = {
  neutral: { icon: CircleHelp, cls: 'text-muted-foreground' },
  success: { icon: CircleCheck, cls: 'text-success' },
  danger: { icon: CircleAlert, cls: 'text-destructive' },
} as const;

type Name = HealthResponse['dependencies'][number]['name'];
const DEPS: Array<{ name: Name; label: string }> = [
  { name: 'postgres', label: 'Database' },
  { name: 'redis', label: 'Job queue' },
  { name: 'audio-service', label: 'Audio service' },
];

const OVERALL = {
  ok: { text: 'All services healthy', cls: 'bg-success-soft text-success' },
  degraded: { text: 'Degraded', cls: 'bg-warning-soft text-warning' },
  down: { text: 'Outage', cls: 'bg-destructive/10 text-destructive' },
} as const;

/** Fixed client copy for known dependency reason codes; unknown codes are not shown. */
const REASON: Record<string, string> = { TIMEOUT: 'timed out', UNREACHABLE: 'unreachable' };

/**
 * `GET /api/v1/health` answers 503 with a full report when a required dependency (Postgres,
 * Redis) is down (API §8), so 503 is a valid result here, not "API unreachable". Any other
 * failure, or a body that does not match the contract, is treated as unreachable.
 */
async function fetchHealth(signal: AbortSignal): Promise<HealthResponse> {
  const res = await fetch('/api/v1/health', { signal, headers: { accept: 'application/json' } });
  if (res.status !== 200 && res.status !== 503)
    throw new Error(`Health check failed (${res.status})`);
  return HealthResponse.parse(await res.json());
}

type HealthPoll =
  { status: 'loading' } | { status: 'success'; data: HealthResponse } | { status: 'error' };

/**
 * Polls /health; the latest result always wins. Unlike `useAsync`, a failed background poll
 * replaces an earlier success, so the panel never keeps claiming health it can no longer verify.
 */
function useHealthPoll(intervalMs: number) {
  const [state, setState] = useState<HealthPoll>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        const data = await fetchHealth(controller.signal);
        if (!controller.signal.aborted) setState({ status: 'success', data });
      } catch {
        if (controller.signal.aborted) return;
        setState({ status: 'error' });
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void run(), intervalMs);
    };
    void run();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [intervalMs, nonce]);
  const reload = useCallback(() => {
    setState({ status: 'loading' });
    setNonce((n) => n + 1);
  }, []);
  return { ...state, reload };
}

function lastChecked(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour12: false });
}

export function SystemHealth() {
  const health = useHealthPoll(30_000);
  const data = health.status === 'success' ? health.data : null;

  const rows: Array<{ label: string; state: RowState }> = [
    {
      label: 'API',
      state:
        health.status === 'loading'
          ? { tone: 'neutral', text: 'Checking…' }
          : data
            ? { tone: 'success', text: 'Healthy · responding' }
            : { tone: 'danger', text: 'Unavailable' },
    },
    ...DEPS.map(({ name, label }): { label: string; state: RowState } => {
      if (health.status === 'loading')
        return { label, state: { tone: 'neutral', text: 'Checking…' } };
      if (!data)
        return { label, state: { tone: 'neutral', text: 'Not checked — API unreachable' } };
      const d = data.dependencies.find((x) => x.name === name);
      if (!d) return { label, state: { tone: 'neutral', text: 'Not reported' } };
      return {
        label,
        state:
          d.status === 'up'
            ? {
                tone: 'success',
                text: d.latencyMs === null ? 'Healthy' : `Healthy · ${d.latencyMs} ms`,
              }
            : {
                tone: 'danger',
                text:
                  d.reason && REASON[d.reason]
                    ? `Unavailable · ${REASON[d.reason]}`
                    : 'Unavailable',
              },
      };
    }),
  ];

  const overall = data ? OVERALL[data.status] : null;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>
          <h2 className="text-lg">System health</h2>
        </CardTitle>
        <CardDescription>Live from the API health endpoint.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div role="status" aria-live="polite" className="grid gap-1.5">
          {overall ? (
            <span className={cn('w-fit rounded-full px-2.5 py-1 text-xs font-medium', overall.cls)}>
              {overall.text}
            </span>
          ) : (
            <span className="text-muted-foreground text-xs font-medium">
              {health.status === 'loading' ? 'Checking services…' : 'Health status unavailable'}
            </span>
          )}
          {data ? (
            <span className="text-muted-foreground text-xs tabular-nums">
              Last checked {lastChecked(data.time)}
            </span>
          ) : null}
        </div>
        <ul className="divide-y">
          {rows.map(({ label, state }) => {
            const { icon: Icon, cls } = TONE[state.tone];
            return (
              <li key={label} className="flex items-center gap-2.5 py-2.5 text-sm">
                <Icon aria-hidden className={cn('size-4 shrink-0', cls)} />
                <span className="font-medium">{label}</span>
                <span className="text-muted-foreground ml-auto text-right text-xs tabular-nums">
                  {state.text}
                </span>
              </li>
            );
          })}
        </ul>
        {health.status === 'error' ? (
          <Button variant="outline" size="sm" className="w-fit" onClick={health.reload}>
            <RefreshCw aria-hidden data-icon="inline-start" />
            Retry
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
