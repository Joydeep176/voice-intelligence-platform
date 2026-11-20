import type { RecordingMetadata } from '@vip/contracts';
import { CircleDashed, FolderOpen, type LucideIcon, Upload, XCircle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export type Loaded =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'success'; items: RecordingMetadata[]; partial: boolean };

const KPIS: Array<{
  label: string;
  hint: string;
  icon: LucideIcon;
  match: (r: RecordingMetadata) => boolean;
}> = [
  {
    label: 'Recordings',
    hint: 'Uploads started in this workspace.',
    icon: FolderOpen,
    match: () => true,
  },
  {
    label: 'Awaiting analysis',
    hint: 'Stored and ready; analysis pipeline arrives in a later phase.',
    icon: CircleDashed,
    match: (r) => r.latestRun?.status === 'created',
  },
  {
    label: 'Uploads in progress',
    hint: 'Started but not completed.',
    icon: Upload,
    match: (r) => r.status === 'uploading',
  },
  {
    label: 'Rejected uploads',
    hint: 'Content did not match the declared audio format.',
    icon: XCircle,
    match: (r) => r.status === 'invalid',
  },
];

export function KpiCards({ data }: { data: Loaded }) {
  return (
    <section aria-label="Summary" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      {KPIS.map(({ label, hint, icon: Icon, match }) => {
        const n = data.status === 'success' ? data.items.filter(match).length : 0;
        return (
          <Card key={label} className="gap-3 p-4 sm:p-5">
            <div className="flex items-center gap-2 sm:gap-3">
              <span
                aria-hidden
                className="bg-muted text-muted-foreground grid size-8 shrink-0 place-items-center rounded-lg"
              >
                <Icon className="size-4" />
              </span>
              <span className="text-muted-foreground min-w-0 text-sm leading-tight font-medium">
                {label}
              </span>
            </div>
            <div className="text-4xl leading-none font-semibold tracking-tight tabular-nums">
              {data.status === 'loading' ? (
                <>
                  <Skeleton className="h-9 w-16" />
                  <span className="sr-only">Loading</span>
                </>
              ) : data.status === 'error' ? (
                <span aria-label="Not available">—</span>
              ) : (
                `${n}${data.partial ? '+' : ''}`
              )}
            </div>
            <p className="text-muted-foreground text-xs leading-snug">{hint}</p>
          </Card>
        );
      })}
    </section>
  );
}
