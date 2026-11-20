import type { HealthResponse, RecordingMetadata } from '@vip/contracts';
import { CircleDashed, FolderOpen, type LucideIcon, Upload, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { RecordingsTable } from '@/components/recordings-table';
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/states';
import { api } from '@/lib/api';
import { Link } from '@/lib/router';
import { useAsync } from '@/lib/use-async';
import { cn } from 'cn';

const SAMPLE = 100;

function Stat({
  label,
  value,
  icon: Icon,
  hint,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  hint: string;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          <Icon aria-hidden className="size-4" />
          {label}
        </CardDescription>
        <CardTitle className="text-3xl font-semibold tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-muted-foreground text-xs">{hint}</CardContent>
    </Card>
  );
}

function summarise(items: RecordingMetadata[]) {
  return {
    total: items.length,
    awaiting: items.filter((r) => r.latestRun?.status === 'created').length,
    rejected: items.filter((r) => r.status === 'invalid').length,
  };
}

const DEP_LABEL: Record<HealthResponse['dependencies'][number]['name'], string> = {
  postgres: 'Database',
  redis: 'Job queue',
  'audio-service': 'Audio service',
};

function SystemStatus() {
  const health = useAsync((signal) => api.health(signal), [], 30_000);
  return (
    <Card>
      <CardHeader>
        <CardTitle>System status</CardTitle>
        <CardDescription>Live from the API health endpoint.</CardDescription>
        {health.status === 'success' ? (
          <CardAction>
            <Badge variant="outline" className="capitalize">
              {health.data.status}
            </Badge>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {health.status === 'loading' ? <LoadingRows rows={3} label="Checking services" /> : null}
        {health.status === 'error' ? (
          <ErrorState error={health.error} onRetry={health.reload} title="API unreachable" />
        ) : null}
        {health.status === 'success' ? (
          <ul className="grid gap-2.5">
            {health.data.dependencies.map((d) => (
              <li key={d.name} className="flex items-center gap-2 text-sm">
                <span
                  aria-hidden
                  className={cn(
                    'size-2 rounded-full',
                    d.status === 'up' ? 'bg-success' : 'bg-destructive',
                  )}
                />
                <span>{DEP_LABEL[d.name]}</span>
                <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                  {d.status === 'up' ? `Up · ${d.latencyMs ?? 0} ms` : 'Down'}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const recordings = useAsync((signal) => api.listRecordings({ limit: SAMPLE }, signal), []);
  const items = recordings.status === 'success' ? recordings.data.items : [];
  const more = recordings.status === 'success' && recordings.data.nextCursor !== null;
  const stats = summarise(items);
  const count = (n: number) => (recordings.status === 'success' ? `${n}${more ? '+' : ''}` : '—');

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Overview"
        description="Upload consented or synthetic recordings and follow their processing status."
        actions={
          <Button asChild>
            <Link to="/recordings/new">
              <Upload aria-hidden data-icon="inline-start" />
              Upload recording
            </Link>
          </Button>
        }
      />

      <section aria-label="Summary" className="grid gap-4 sm:grid-cols-3">
        <Stat
          label="Recordings"
          value={count(stats.total)}
          icon={FolderOpen}
          hint={more ? `Showing the latest ${SAMPLE}` : 'In this workspace'}
        />
        <Stat
          label="Awaiting analysis"
          value={count(stats.awaiting)}
          icon={CircleDashed}
          hint="Stored; analysis pipeline not available yet"
        />
        <Stat
          label="Rejected uploads"
          value={count(stats.rejected)}
          icon={XCircle}
          hint="Content did not match the declared format"
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Card>
          <CardHeader>
            <CardTitle>Recent recordings</CardTitle>
            <CardAction>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/recordings">View all</Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {recordings.status === 'loading' ? <LoadingRows label="Loading recordings" /> : null}
            {recordings.status === 'error' ? (
              <ErrorState error={recordings.error} onRetry={recordings.reload} />
            ) : null}
            {recordings.status === 'success' && items.length === 0 ? (
              <EmptyState
                icon={<FolderOpen aria-hidden />}
                title="No recordings yet"
                description="Upload a synthetic or explicitly consented audio file to get started."
                action={
                  <Button asChild size="sm">
                    <Link to="/recordings/new">Upload recording</Link>
                  </Button>
                }
              />
            ) : null}
            {items.length > 0 ? (
              <RecordingsTable items={items.slice(0, 5)} caption="Most recent recordings" />
            ) : null}
          </CardContent>
        </Card>
        <SystemStatus />
      </div>
    </div>
  );
}
