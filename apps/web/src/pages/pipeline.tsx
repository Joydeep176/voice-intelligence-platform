import { Uuid } from '@vip/contracts';
import { CircleSlash } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PipelineDiagram, useMediaQuery } from '@/components/pipeline/diagram';
import { AgentPanel } from '@/components/pipeline/agent-panel';
import { PipelineListView } from '@/components/pipeline/list-view';
import { RecordingPicker, RunContext } from '@/components/pipeline/run-context';
import { PipelineLegend, WhatRunsToday } from '@/components/pipeline/status-info';
import { nodeById, nodeLabel, type NodeId } from '@/components/pipeline/topology';
import { Button } from '@/components/ui/button';
import { EmptyState, PageHeader } from '@/components/states';

/** `?recording=<uuid>`: `undefined` when absent, `null` when present but not a UUID. */
function readRecordingParam(): string | null | undefined {
  const raw = new URLSearchParams(window.location.search).get('recording');
  if (raw === null) return undefined;
  const parsed = Uuid.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function useRecordingParam() {
  const [value, setValue] = useState(readRecordingParam);
  useEffect(() => {
    const sync = () => setValue(readRecordingParam());
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  const set = useCallback((id: string | null) => {
    window.history.replaceState(null, '', id ? `/pipeline?recording=${id}` : '/pipeline');
    setValue(id ?? undefined);
  }, []);
  return [value, set] as const;
}

export default function PipelinePage() {
  const [recording, setRecording] = useRecordingParam();
  const [selected, setSelected] = useState<NodeId | null>('pre');
  // The agent panel sits beside the diagram only when there is room (about 1300 px and up).
  const beside = useMediaQuery('(min-width: 1296px)');
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const diagram = useRef<HTMLDivElement>(null);

  const select = (id: NodeId) => {
    setSelected(id);
    // Below the diagram the panel is out of sight: move focus to it so keyboard use stays sensible.
    if (!beside) requestAnimationFrame(() => panelHeading.current?.focus());
  };
  const backToDiagram = () =>
    diagram.current?.querySelector<HTMLElement>(`[data-node="${selected}"]`)?.focus();

  const node = selected ? nodeById(selected) : null;

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Pipeline"
        description="How a recording is designed to be analysed: a deterministic preprocessing stage, then seven agents on two parallel branches. Planned only. No agent runs in this build."
      />

      {recording === null ? (
        <EmptyState
          icon={<CircleSlash aria-hidden />}
          title="Invalid recording id"
          description="The recording in the address is not a valid identifier."
          action={
            <Button variant="outline" size="sm" onClick={() => setRecording(null)}>
              Show the pipeline without a recording
            </Button>
          }
        />
      ) : recording ? (
        <RunContext key={recording} id={recording} onClear={() => setRecording(null)} />
      ) : (
        <RecordingPicker onPick={setRecording} />
      )}

      <div
        className={beside ? 'grid grid-cols-[minmax(0,1fr)_18rem] items-start gap-6' : 'grid gap-6'}
      >
        <section
          aria-label="Pipeline diagram"
          ref={diagram}
          className="bg-card ring-foreground/10 relative min-w-0 self-start overflow-hidden rounded-xl p-3 shadow-sm ring-1 sm:p-5"
        >
          <div
            aria-hidden
            className="bg-brand-gradient pointer-events-none absolute inset-x-0 top-0 h-px opacity-70"
          />
          <PipelineDiagram selected={selected} onSelect={select} />
          <p role="status" className="sr-only">
            {node ? `Selected ${nodeLabel(node)}. Details are in the agent panel.` : ''}
          </p>
        </section>
        <div className={beside ? 'sticky top-20' : undefined}>
          <AgentPanel
            node={node}
            headingRef={panelHeading}
            onBack={backToDiagram}
            showBack={!beside}
          />
        </div>
      </div>

      <PipelineListView />

      <div className="grid gap-6 md:grid-cols-2">
        <WhatRunsToday />
        <PipelineLegend withRun={Boolean(recording)} />
      </div>
    </div>
  );
}
