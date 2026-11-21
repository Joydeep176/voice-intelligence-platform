import type { RecordingMetadata } from '@vip/contracts';
import { FileAudio } from 'lucide-react';
import { RunStatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime } from '@/lib/format';
import { Link } from '@/lib/router';
import { reportAvailability } from './model';

const HEAD = 'text-muted-foreground h-10 text-xs font-medium tracking-wide uppercase';
const LINK =
  'focus-visible:ring-ring/50 rounded-sm font-medium outline-none hover:underline focus-visible:ring-[3px]';

function RunCell({ r }: { r: RecordingMetadata }) {
  return r.latestRun ? (
    <RunStatusBadge status={r.latestRun.status} />
  ) : (
    <span className="text-muted-foreground text-xs">No run</span>
  );
}

function Availability({ r }: { r: RecordingMetadata }) {
  const a = reportAvailability(r);
  return (
    <div className="grid justify-items-start gap-1">
      <Badge variant="secondary" className="bg-muted text-muted-foreground">
        {a.label}
      </Badge>
      <span className="text-muted-foreground text-xs">{a.reason}</span>
    </div>
  );
}

function OpenLink({ r }: { r: RecordingMetadata }) {
  return (
    <Link
      to={`/recordings/${r.id}/report`}
      aria-label={`Open report for ${r.originalFilename}`}
      className={`${LINK} text-sm whitespace-nowrap underline-offset-4`}
    >
      Open report
    </Link>
  );
}

export function ReportsList({ items }: { items: RecordingMetadata[] }) {
  return (
    <>
      <div className="hidden md:block">
        <Table>
          <caption className="sr-only">Report availability by recording</caption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={`${HEAD} pl-4`}>Recording</TableHead>
              <TableHead className={HEAD}>Uploaded</TableHead>
              <TableHead className={HEAD}>Run</TableHead>
              <TableHead className={HEAD}>Report</TableHead>
              <TableHead className={`${HEAD} pr-4 text-right`}>
                <span className="sr-only">Action</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((r) => (
              <TableRow key={r.id} className="h-16">
                <TableCell className="max-w-0 min-w-48 py-2 pl-4">
                  <Link
                    to={`/recordings/${r.id}`}
                    title={r.originalFilename}
                    className={`${LINK} flex min-w-0 items-center gap-2.5`}
                  >
                    <FileAudio aria-hidden className="text-muted-foreground size-4 shrink-0" />
                    <span className="truncate">{r.originalFilename}</span>
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                  <time dateTime={r.createdAt}>{formatDateTime(r.createdAt)}</time>
                </TableCell>
                <TableCell>
                  <RunCell r={r} />
                </TableCell>
                <TableCell>
                  <Availability r={r} />
                </TableCell>
                <TableCell className="pr-4 text-right">
                  <OpenLink r={r} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul aria-label="Report availability by recording" className="divide-y md:hidden">
        {items.map((r) => (
          <li key={r.id} className="grid gap-2 p-4">
            <Link
              to={`/recordings/${r.id}`}
              title={r.originalFilename}
              className={`${LINK} flex min-w-0 items-center gap-2.5`}
            >
              <FileAudio aria-hidden className="text-muted-foreground size-4 shrink-0" />
              <span className="truncate">{r.originalFilename}</span>
            </Link>
            <p className="text-muted-foreground text-xs">
              Uploaded <time dateTime={r.createdAt}>{formatDateTime(r.createdAt)}</time>
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <RunCell r={r} />
            </div>
            <Availability r={r} />
            <div>
              <OpenLink r={r} />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
