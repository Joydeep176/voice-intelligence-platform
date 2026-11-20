import type { RecordingMetadata } from '@vip/contracts';
import { FileAudio } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatBytes, formatDateTime, formatDuration } from '@/lib/format';
import { Link } from '@/lib/router';
import { formatLabel } from './recordings/model';
import { RecordingStatusBadge, RunStatusBadge } from './status-badge';

const HEAD = 'text-muted-foreground h-10 text-xs font-medium tracking-wide uppercase';

/** Priority columns stay visible on narrow screens; the rest move into the meta line (layout-responsive.md). */
export function RecordingsTable({
  items,
  caption,
}: {
  items: RecordingMetadata[];
  caption: string;
}) {
  return (
    <Table className="min-w-[20rem]">
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className={`${HEAD} pl-4`}>Recording</TableHead>
          <TableHead className={HEAD}>Upload status</TableHead>
          <TableHead className={`${HEAD} hidden md:table-cell`}>Processing</TableHead>
          <TableHead className={`${HEAD} hidden lg:table-cell`}>Format</TableHead>
          <TableHead className={`${HEAD} hidden text-right sm:table-cell`}>Size</TableHead>
          <TableHead className={`${HEAD} hidden text-right xl:table-cell`}>Duration</TableHead>
          <TableHead className={`${HEAD} hidden pr-4 md:table-cell`}>Uploaded</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((r) => (
          <TableRow key={r.id} className="h-14">
            <TableCell className="w-full max-w-0 py-2 pl-4">
              <Link
                to={`/recordings/${r.id}`}
                title={r.originalFilename}
                className="focus-visible:ring-ring/50 flex min-w-0 items-center gap-2.5 rounded-sm font-medium outline-none hover:underline focus-visible:ring-[3px]"
              >
                <FileAudio aria-hidden className="text-muted-foreground size-4 shrink-0" />
                <span className="truncate">{r.originalFilename}</span>
              </Link>
              <p className="text-muted-foreground mt-0.5 truncate pl-[1.65rem] text-xs tabular-nums lg:hidden">
                {formatLabel(r.mimeType)}
                <span className="sm:hidden"> · {formatBytes(r.sizeBytes)}</span>
              </p>
            </TableCell>
            <TableCell>
              <RecordingStatusBadge status={r.status} />
            </TableCell>
            <TableCell className="hidden md:table-cell">
              {r.latestRun ? (
                <RunStatusBadge status={r.latestRun.status} />
              ) : (
                <span className="text-muted-foreground text-xs">No run</span>
              )}
            </TableCell>
            <TableCell className="text-muted-foreground hidden text-xs lg:table-cell">
              {formatLabel(r.mimeType)}
            </TableCell>
            <TableCell className="hidden text-right tabular-nums sm:table-cell">
              {formatBytes(r.sizeBytes)}
            </TableCell>
            <TableCell className="text-muted-foreground hidden text-right tabular-nums xl:table-cell">
              {r.durationMs === null ? (
                <>
                  <span aria-hidden>—</span>
                  <span className="sr-only">not yet determined</span>
                </>
              ) : (
                formatDuration(r.durationMs)
              )}
            </TableCell>
            <TableCell className="text-muted-foreground hidden pr-4 md:table-cell">
              <time dateTime={r.createdAt}>{formatDateTime(r.createdAt)}</time>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
