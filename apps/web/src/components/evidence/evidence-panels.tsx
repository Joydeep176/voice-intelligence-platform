import type { ReactNode } from 'react';
import {
  FileSearch,
  FileText,
  Quote,
  Radio,
  Scale,
  Search,
  Sparkles,
  TextQuote,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { SlotCard } from '@/components/reports/report-panels';
import { cn } from 'cn';

const CHIP = {
  recorded: {
    label: 'Recorded',
    icon: Radio,
    tone: 'text-provenance-recorded bg-provenance-recorded/10 border-provenance-recorded/30',
  },
  external: {
    label: 'External',
    icon: FileSearch,
    tone: 'text-provenance-external bg-provenance-external/10 border-provenance-external/30',
  },
  inferred: {
    label: 'Inferred',
    icon: Sparkles,
    tone: 'text-provenance-inferred bg-provenance-inferred/10 border-provenance-inferred/30',
  },
} as const;

function ProvenanceChip({ type }: { type: keyof typeof CHIP }) {
  const { label, icon: Icon, tone } = CHIP[type];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium',
        tone,
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      {label}
    </span>
  );
}

const STEPS: { title: string; body: string; chip?: keyof typeof CHIP }[] = [
  {
    title: 'Claim',
    chip: 'recorded',
    body: 'A verbatim quotation from the transcript, with speaker and time span. Any reworded version is kept separate and marked Inferred. Produced by Context Intelligence.',
  },
  {
    title: 'Research question',
    body: 'Written without raw transcript excerpts or unnecessary personal data, and recorded exactly as sent. Produced by Research.',
  },
  {
    title: 'Source',
    body: 'URL, title, publisher, publication date, retrieval time, content hash and a stored snapshot. Retrieved as fetched or snippet-only.',
  },
  {
    title: 'Evidence passage',
    body: 'A verbatim quotation from the stored snapshot, marked as supporting, contradicting or giving context to the claim.',
  },
  {
    title: 'Validation',
    body: 'A verdict with confidence, rationale and linked evidence. Unresolved claims get one targeted research retry. Produced by Fact Validation. Verdict categories are not decided yet.',
  },
  {
    title: 'Report statement',
    chip: 'external',
    body: 'Appears in the report with External provenance and references to its evidence. Produced by Reporting.',
  },
];

export function EvidenceFlow() {
  return (
    <Card role="region" aria-labelledby="evidence-flow">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="evidence-flow" className="text-base leading-snug font-medium">
            How evidence will work
          </h2>
          <Badge variant="outline">Planned</Badge>
        </div>
        <CardDescription>
          This describes the planned flow. Nothing below is data from this recording.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="grid gap-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className="relative flex gap-3">
              {i < STEPS.length - 1 && (
                <span
                  aria-hidden
                  className="bg-border absolute top-8 bottom-[-1rem] left-3.5 w-px -translate-x-1/2"
                />
              )}
              <span
                aria-hidden
                className="bg-muted text-muted-foreground relative flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium"
              >
                {i + 1}
              </span>
              <div className="grid min-w-0 content-start gap-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {s.title}
                  {s.chip && <ProvenanceChip type={s.chip} />}
                </p>
                <p className="text-muted-foreground text-sm break-words">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

const LINKS = [
  {
    type: 'recorded',
    meaning: 'Said in the recording.',
    text: 'Links to transcript time references.',
  },
  {
    type: 'external',
    meaning: 'From research evidence.',
    text: 'Links to evidence passages from stored source snapshots.',
  },
  {
    type: 'inferred',
    meaning: 'AI interpretation.',
    text: 'Links to the statements it is based on, with a confidence level.',
  },
] as const;

export function ProvenanceLinks() {
  return (
    <Card role="region" aria-labelledby="evidence-links">
      <CardHeader>
        <h2 id="evidence-links" className="text-base leading-snug font-medium">
          Recorded, external and inferred
        </h2>
        <CardDescription>
          Every assertion in a report will carry one of these three provenance types.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-3">
          {LINKS.map(({ type, meaning, text }) => (
            <li key={type} className="grid gap-1.5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4">
              <span>
                <ProvenanceChip type={type} />
              </span>
              <span className="grid gap-0.5 text-sm">
                <span className="font-medium">{meaning}</span>
                <span className="text-muted-foreground">{text}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm font-medium">An inference is never presented as verified.</p>
      </CardContent>
    </Card>
  );
}

export function SourceTypes() {
  const items: { icon: ReactNode; title: string; text: string }[] = [
    {
      icon: <FileText aria-hidden className="size-4" />,
      title: 'Fetched',
      text: 'The source was retrieved and a snapshot stored. Only fetched sources can support or contradict a claim.',
    },
    {
      icon: <TextQuote aria-hidden className="size-4" />,
      title: 'Snippet-only',
      text: 'Only a search snippet is available. It can add context but never supports or contradicts a claim.',
    },
  ];
  return (
    <Card role="region" aria-labelledby="evidence-source-types">
      <CardHeader>
        <h2 id="evidence-source-types" className="text-base leading-snug font-medium">
          Fetched and snippet-only sources
        </h2>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-3">
          {items.map((i) => (
            <li key={i.title} className="grid gap-1 rounded-lg border p-3">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                {i.icon}
                {i.title}
              </span>
              <span className="text-muted-foreground text-sm">{i.text}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function EvidenceSlots() {
  const ic = (I: typeof Quote) => <I aria-hidden className="size-4" />;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <SlotCard
        id="evidence-claims"
        title="Claims"
        icon={ic(Quote)}
        description="Verbatim quotation, speaker and transcript time. Any reworded version is shown separately and marked Inferred."
      />
      <SlotCard
        id="evidence-queries"
        title="Research queries"
        icon={ic(Search)}
        description="Each query exactly as sent, with its attempt and the minimisation applied."
      />
      <SlotCard
        id="evidence-sources"
        title="Sources"
        icon={ic(FileSearch)}
        description="URL, title, publisher, publication and retrieval dates, retrieval type, content hash and snapshot."
      />
      <SlotCard
        id="evidence-passages"
        title="Evidence passages"
        icon={ic(TextQuote)}
        description="The verbatim passage, whether it supports, contradicts or gives context, and its location in the source."
      />
      <SlotCard
        id="evidence-validation"
        title="Validation"
        icon={ic(Scale)}
        description="Verdict, confidence, rationale and linked evidence. Verdict categories are not decided yet."
      />
    </div>
  );
}

const NEEDED = [
  ['Context Intelligence, Research and Fact Validation agents', 'not implemented'],
  ['A research provider', 'not selected'],
  ['Verdict categories', 'not decided'],
  ['Source snapshot storage and retention policy', 'not decided'],
] as const;

export function WhatIsNeeded() {
  return (
    <Card role="region" aria-labelledby="evidence-needed">
      <CardHeader>
        <h2 id="evidence-needed" className="text-base leading-snug font-medium">
          What is needed
        </h2>
      </CardHeader>
      <CardContent>
        <ul className="grid list-disc gap-2 pl-5 text-sm">
          {NEEDED.map(([what, state]) => (
            <li key={what} className="break-words">
              {what} <span className="text-muted-foreground">({state})</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
