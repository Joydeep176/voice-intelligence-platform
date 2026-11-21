import type { RecordingMetadata } from '@vip/contracts';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { reportAvailability } from '@/components/reports/model';
import { Link } from '@/lib/router';

/** Compact report entry point on the recording detail page. Never implies a report exists. */
export function ReportCard({ r }: { r: RecordingMetadata }) {
  const a = reportAvailability(r);
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Report</CardTitle>
        <CardDescription>
          {a.label} · {a.reason}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <Link to={`/recordings/${r.id}/report`}>
            Open report workspace
            <ArrowRight aria-hidden data-icon="inline-end" />
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link to={`/recordings/${r.id}/evidence`} aria-label="Open evidence workspace">
            Evidence
            <ArrowRight aria-hidden data-icon="inline-end" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
