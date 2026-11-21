import type { ReactNode } from 'react';
import {
  ArrowRight,
  Brain,
  Download,
  FileSearch,
  Quote,
  Radio,
  Sparkles,
  Waves,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Link } from '@/lib/router';
import { cn } from 'cn';

export const NOT_AVAILABLE = 'Not available yet';

export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm font-medium break-words">{children}</dd>
    </div>
  );
}

export function Unavailable() {
  return <span className="text-muted-foreground font-normal">{NOT_AVAILABLE}</span>;
}

/** Dashed, muted slot. Static (no skeleton): nothing is loading. */
export function EmptySlot({ children }: { children: ReactNode }) {
  return (
    <div className="text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-sm">
      <p className="text-foreground font-medium">{NOT_AVAILABLE}</p>
      <p className="mx-auto mt-1 max-w-prose">{children}</p>
    </div>
  );
}

export function SlotCard({
  id,
  title,
  description,
  icon,
  size,
  children,
}: {
  id: string;
  title: string;
  description: string;
  icon?: ReactNode;
  size?: 'sm';
  children?: ReactNode;
}) {
  return (
    <Card size={size} aria-labelledby={id} role="region">
      <CardHeader>
        <h2
          id={id}
          className={cn(
            'flex items-center gap-2 text-base leading-snug font-medium',
            size === 'sm' && 'text-sm',
          )}
        >
          {icon}
          {title}
        </h2>
      </CardHeader>
      <CardContent>
        <EmptySlot>{description}</EmptySlot>
        {children}
      </CardContent>
    </Card>
  );
}

const PROVENANCE = [
  {
    key: 'recorded',
    label: 'Recorded',
    icon: Radio,
    text: 'From the recording, with transcript time references.',
    tone: 'text-provenance-recorded bg-provenance-recorded/10 border-provenance-recorded/30',
  },
  {
    key: 'external',
    label: 'External',
    icon: FileSearch,
    text: 'From research evidence, with source references.',
    tone: 'text-provenance-external bg-provenance-external/10 border-provenance-external/30',
  },
  {
    key: 'inferred',
    label: 'Inferred',
    icon: Sparkles,
    text: 'AI interpretation, with its basis and a confidence level.',
    tone: 'text-provenance-inferred bg-provenance-inferred/10 border-provenance-inferred/30',
  },
] as const;

export function ProvenanceLegend() {
  return (
    <Card role="region" aria-labelledby="report-provenance">
      <CardHeader>
        <h2 id="report-provenance" className="text-base leading-snug font-medium">
          Provenance
        </h2>
        <CardDescription>
          Every assertion in a report will carry one of these three provenance types.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-3">
          {PROVENANCE.map(({ key, label, icon: Icon, text, tone }) => (
            <li key={key} className={cn('grid content-start gap-1.5 rounded-lg border p-3', tone)}>
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <Icon aria-hidden className="size-4" />
                {label}
              </span>
              <span className="text-foreground/80 text-xs">{text}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function ReportSlots({ recordingId }: { recordingId: string }) {
  return (
    <>
      <SlotCard
        id="report-sections"
        title="Report sections"
        description="Sections and their assertions, each with provenance and references, appear once the Reporting agent produces the report."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SlotCard
          size="sm"
          id="report-audio"
          title="Audio limitations"
          icon={<Waves aria-hidden className="size-4" />}
          description="Signal diagnostics from the Audio Quality agent."
        />
        <SlotCard
          size="sm"
          id="report-uncertainty"
          title="Transcription uncertainty"
          icon={<Brain aria-hidden className="size-4" />}
          description="Model-level uncertainty from the Transcription agent."
        />
      </div>
      <SlotCard
        id="report-references"
        title="References and evidence"
        icon={<Quote aria-hidden className="size-4" />}
        description="Transcript time references and source snapshots will be linked from each assertion. Evidence exploration comes later."
      >
        <div className="mt-3 flex justify-center">
          <Button asChild variant="outline" size="sm">
            <Link to={`/recordings/${recordingId}/evidence`}>
              Open evidence workspace
              <ArrowRight aria-hidden data-icon="inline-end" />
            </Link>
          </Button>
        </div>
      </SlotCard>
      <Card role="region" aria-labelledby="report-export">
        <CardHeader>
          <h2
            id="report-export"
            className="flex items-center gap-2 text-base leading-snug font-medium"
          >
            <Download aria-hidden className="size-4" />
            Export
          </h2>
          <CardDescription>
            PDF and DOCX exports of the report are planned. Export is not available yet.
          </CardDescription>
        </CardHeader>
      </Card>
    </>
  );
}
