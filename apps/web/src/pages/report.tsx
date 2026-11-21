import { Info } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { reportAvailability } from '@/components/reports/model';
import {
  Detail,
  ProvenanceLegend,
  ReportSlots,
  Unavailable,
} from '@/components/reports/report-panels';
import {
  RECORDING_PAGE_CLASS,
  RecordingBreadcrumb,
  recordingStateFallback,
} from '@/components/recording-frame';
import { PageHeader } from '@/components/states';
import { RunStatusBadge } from '@/components/status-badge';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Link } from '@/lib/router';
import { useAsync } from '@/lib/use-async';

export default function ReportPage({ id }: { id: string }) {
  const state = useAsync((signal) => api.getRecording(id, signal), [id]);

  const fallback = recordingStateFallback(state, {
    loadingLabel: 'Loading report',
    backTo: '/reports',
    backLabel: 'Back to reports',
  });
  if (fallback) return fallback;
  if (state.status !== 'success') return null;

  const r = state.data;
  const a = reportAvailability(r);
  return (
    <div className={RECORDING_PAGE_CLASS}>
      <RecordingBreadcrumb
        items={[
          { label: 'Reports', to: '/reports' },
          { label: r.originalFilename, to: `/recordings/${r.id}`, filename: true },
          { label: 'Report' },
        ]}
      />
      <PageHeader
        title="Report"
        description={r.originalFilename}
        actions={<Badge variant="outline">{a.label}</Badge>}
      />
      <Alert role="status">
        <Info aria-hidden />
        <AlertTitle>This report has not been generated</AlertTitle>
        <AlertDescription>
          {a.reason}.{' '}
          <Link to="/pipeline" className="text-foreground underline underline-offset-4">
            See pipeline status
          </Link>
          .
        </AlertDescription>
      </Alert>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid min-w-0 content-start gap-6 lg:col-start-2 lg:row-start-1">
          <Card role="region" aria-labelledby="report-details">
            <CardHeader>
              <h2 id="report-details" className="text-base leading-snug font-medium">
                Report details
              </h2>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
                <Detail label="Recording">
                  <Link to={`/recordings/${r.id}`} className="underline underline-offset-4">
                    {r.originalFilename}
                  </Link>
                </Detail>
                <Detail label="Uploaded">
                  <time dateTime={r.createdAt}>{formatDateTime(r.createdAt)}</time>
                </Detail>
                <Detail label="Analysis run">
                  {r.latestRun ? (
                    <RunStatusBadge status={r.latestRun.status} />
                  ) : (
                    <span className="text-muted-foreground font-normal">No run</span>
                  )}
                </Detail>
                <Detail label="Report version">
                  <Unavailable />
                </Detail>
                <Detail label="Report language">
                  <Unavailable />
                </Detail>
                <Detail label="Source transcript version">
                  <Unavailable />
                </Detail>
                <Detail label="QA review">
                  <Unavailable />
                </Detail>
                <Detail label="Generated">
                  <Unavailable />
                </Detail>
              </dl>
            </CardContent>
          </Card>
          <ProvenanceLegend />
        </div>
        <div className="grid min-w-0 content-start gap-6 lg:col-start-1 lg:row-start-1">
          <ReportSlots recordingId={r.id} />
        </div>
      </div>
    </div>
  );
}
