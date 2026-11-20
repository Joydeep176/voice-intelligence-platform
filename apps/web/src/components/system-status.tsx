import type { HealthResponse } from '@vip/contracts';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/use-async';
import { cn } from 'cn';

const DEP_LABEL: Record<HealthResponse['dependencies'][number]['name'], string> = {
  postgres: 'Database',
  redis: 'Job queue',
  'audio-service': 'Audio service',
};

const SUMMARY = {
  ok: { text: 'All systems operational', dot: 'bg-success' },
  degraded: { text: 'Some services degraded', dot: 'bg-warning' },
  down: { text: 'Service outage', dot: 'bg-destructive' },
} as const;

/**
 * Compact system status for the app shell, from the real `/health` endpoint only. Text always
 * accompanies the coloured dot (accessibility.md); nothing is shown as healthy without data.
 */
export function SystemStatus({ compact = false }: { compact?: boolean }) {
  const health = useAsync((signal) => api.health(signal), [], 60_000);

  const summary =
    health.status === 'success'
      ? SUMMARY[health.data.status]
      : health.status === 'error'
        ? { text: 'Status unavailable', dot: 'bg-muted-foreground' }
        : { text: 'Checking services', dot: 'bg-muted-foreground/60 animate-pulse' };

  const trigger = (
    <button
      type="button"
      className={cn(
        'focus-visible:ring-ring/50 text-muted-foreground hover:text-foreground flex w-full items-center gap-2.5 rounded-lg text-xs outline-none transition-colors duration-(--duration-fast) focus-visible:ring-3',
        compact ? 'justify-center p-2' : 'px-3 py-2',
      )}
    >
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', summary.dot)} />
      <span className={cn('truncate', compact && 'sr-only')}>{summary.text}</span>
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side={compact ? 'right' : 'top'} className="max-w-64">
        {health.status === 'success' ? (
          <ul className="grid gap-1">
            {health.data.dependencies.map((d) => (
              <li key={d.name} className="flex gap-3">
                <span>{DEP_LABEL[d.name]}</span>
                <span className="ml-auto tabular-nums">
                  {d.status === 'up' ? `Up · ${d.latencyMs ?? 0} ms` : 'Down'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          summary.text
        )}
      </TooltipContent>
    </Tooltip>
  );
}
