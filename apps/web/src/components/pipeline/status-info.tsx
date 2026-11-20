import { CircleDashed } from 'lucide-react';
import { cn } from 'cn';
import { SURFACE } from './surface';

const IMPLEMENTED = [
  'Consented upload',
  'Resumable chunked upload',
  'Audio signature validation',
  'Storage',
  'Run record created at upload',
  'Signed playback',
  'Service health',
];

const PLANNED = ['Preprocessing node', 'A1 to A7 agents'];

const Chip = ({ children }: { children: string }) => (
  <li className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-medium">
    {children}
  </li>
);

/** What the status words mean. Only values this build can produce are listed as live. */
export function PipelineLegend({ withRun }: { withRun: boolean }) {
  return (
    <section className={cn(SURFACE, 'grid content-start gap-4 p-4')}>
      <h2 className="text-base font-medium">Status legend</h2>
      <div className="grid gap-1.5">
        <h3 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          Capability
        </h3>
        <ul className="flex flex-wrap gap-1.5">
          <Chip>Implemented</Chip>
          <Chip>Planned</Chip>
        </ul>
        <p className="text-muted-foreground text-xs">
          Every node in this graph is planned. None is implemented.
        </p>
      </div>
      <div className="grid gap-1.5">
        <h3 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          Execution
        </h3>
        <ul className="flex flex-wrap gap-1.5">
          <Chip>Not connected</Chip>
          {withRun ? <Chip>Not started</Chip> : null}
        </ul>
        <p className="text-muted-foreground text-xs">
          Not connected: no agent runs in this build.
          {withRun ? ' Not started: the run record exists but was never submitted.' : ''} Running,
          Completed and Failed will appear only once agents execute.
        </p>
      </div>
    </section>
  );
}

export function WhatRunsToday() {
  return (
    <section className={cn(SURFACE, 'grid content-start gap-4 p-4')}>
      <header className="grid gap-1">
        <h2 className="text-base font-medium">What runs today</h2>
        <p className="text-muted-foreground text-sm">
          Ingestion only. Nothing is analysed after upload.
        </p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2">
        <section aria-labelledby="runs-impl" className="grid content-start gap-2">
          <h3 id="runs-impl" className="text-sm font-semibold">
            Implemented
          </h3>
          <ul className="grid gap-1.5">
            {IMPLEMENTED.map((t) => (
              <li key={t} className="flex gap-2 text-sm">
                <span aria-hidden className="bg-success mt-1.5 size-1.5 shrink-0 rounded-full" />
                {t}
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="runs-planned" className="grid content-start gap-2">
          <h3 id="runs-planned" className="text-muted-foreground text-sm font-semibold">
            Planned
          </h3>
          <ul className="text-muted-foreground grid gap-1.5">
            {PLANNED.map((t) => (
              <li key={t} className="flex gap-2 text-sm">
                <CircleDashed aria-hidden className="mt-0.5 size-4 shrink-0" />
                {t}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </section>
  );
}
