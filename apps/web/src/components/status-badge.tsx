import type { RecordingStatus, RunStatus } from '@vip/contracts';
import {
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Clock,
  Loader2,
  TriangleAlert,
  Upload,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from 'cn';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const TONES: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-destructive/10 text-destructive',
  info: 'bg-info-soft text-info',
};

const RECORDING: Record<RecordingStatus, { label: string; tone: Tone; icon: typeof Clock }> = {
  uploading: { label: 'Uploading', tone: 'info', icon: Upload },
  uploaded: { label: 'Uploaded', tone: 'success', icon: CheckCircle2 },
  validating: { label: 'Validating', tone: 'info', icon: Loader2 },
  valid: { label: 'Valid', tone: 'success', icon: CheckCircle2 },
  invalid: { label: 'Rejected', tone: 'danger', icon: XCircle },
  deleting: { label: 'Deleting', tone: 'neutral', icon: CircleSlash },
};

/** `created` means recorded but never submitted to a pipeline (ADR-0025). */
const RUN: Record<RunStatus, { label: string; tone: Tone; icon: typeof Clock }> = {
  created: { label: 'Not started', tone: 'neutral', icon: CircleDashed },
  queued: { label: 'Queued', tone: 'info', icon: Clock },
  running: { label: 'Running', tone: 'info', icon: Loader2 },
  cancelling: { label: 'Cancelling', tone: 'warning', icon: CircleSlash },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: CircleSlash },
  completed: { label: 'Completed', tone: 'success', icon: CheckCircle2 },
  failed: { label: 'Failed', tone: 'danger', icon: XCircle },
  needs_review: { label: 'Needs review', tone: 'warning', icon: TriangleAlert },
};

function StatusPill({
  label,
  tone,
  icon: Icon,
  className,
}: {
  label: string;
  tone: Tone;
  icon: typeof Clock;
  className?: string;
}) {
  // Icon + text, never colour alone (accessibility.md).
  return (
    <Badge variant="secondary" className={cn('gap-1 font-medium', TONES[tone], className)}>
      <Icon aria-hidden className="size-3" />
      {label}
    </Badge>
  );
}

export function RecordingStatusBadge({ status }: { status: RecordingStatus }) {
  return <StatusPill {...RECORDING[status]} />;
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <StatusPill {...RUN[status]} />;
}

export const runStatusLabel = (status: RunStatus) => RUN[status].label;
