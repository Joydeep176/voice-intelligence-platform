import { type CSSProperties, type ReactNode, useSyncExternalStore } from 'react';
import { cn } from 'cn';
import { nodeById, PROPOSED_LABEL, RETRY_LABEL, type NodeId, type PipelineNode } from './topology';

/**
 * The pipeline drawn from `topology.ts` with plain HTML and CSS: nodes are buttons, connectors are
 * borders. Dashed edges are reserved for the retry loop (brand tone) and the proposed edge (warning
 * tone); everything else is a solid dependency. Nothing animates and nothing implies execution.
 */

const EXEC_NOTE_ID = 'pipeline-exec-note';

type Tone = 'solid' | 'retry' | 'proposed';

const TONE_BORDER: Record<Tone, string> = {
  solid: 'border-muted-foreground/50',
  retry: 'border-primary/70 border-dashed',
  proposed: 'border-warning/80 border-dashed',
};
const TONE_TEXT: Record<Tone, string> = {
  solid: 'text-muted-foreground/70',
  retry: 'text-primary/80',
  proposed: 'text-warning',
};

function Arrow({
  dir,
  tone = 'solid',
  className,
}: {
  dir: 'right' | 'down' | 'up';
  tone?: Tone;
  className?: string;
}) {
  const rotate = dir === 'down' ? 'rotate-90' : dir === 'up' ? '-rotate-90' : '';
  return (
    <svg
      aria-hidden
      viewBox="0 0 8 8"
      className={cn('absolute size-2', rotate, TONE_TEXT[tone], className)}
    >
      <path d="M1 0.5 7 4 1 7.5z" fill="currentColor" />
    </svg>
  );
}

const HLine = ({ tone = 'solid', className }: { tone?: Tone; className?: string }) => (
  <span aria-hidden className={cn('absolute border-t-[1.5px]', TONE_BORDER[tone], className)} />
);
const VLine = ({ tone = 'solid', className }: { tone?: Tone; className?: string }) => (
  <span aria-hidden className={cn('absolute border-l-[1.5px]', TONE_BORDER[tone], className)} />
);

function NodeButton({
  node,
  selected,
  onSelect,
}: {
  node: PipelineNode;
  selected: boolean;
  onSelect: (id: NodeId) => void;
}) {
  const stage = node.kind === 'deterministic';
  return (
    <button
      type="button"
      data-node={node.id}
      aria-pressed={selected}
      aria-describedby={EXEC_NOTE_ID}
      onClick={() => onSelect(node.id)}
      className={cn(
        'focus-visible:ring-ring/60 grid h-[4.75rem] w-full min-w-0 grid-cols-[auto_1fr] content-between gap-1 border px-2.5 py-2 text-left outline-none focus-visible:ring-3',
        'transition-[border-color,box-shadow,background-color] duration-(--duration-fast) motion-reduce:transition-none',
        stage ? 'bg-muted rounded-md' : 'bg-card rounded-xl',
        selected
          ? 'border-primary ring-primary/30 shadow-md ring-2'
          : 'border-border shadow-xs hover:border-primary/40 hover:shadow-sm',
      )}
    >
      <span className="text-primary col-start-1 row-start-1 font-mono text-[11px] font-semibold tracking-wide">
        {node.code}
      </span>
      <span className="col-span-2 col-start-1 row-start-2 grid min-w-0 gap-0.5">
        <span className="text-xs leading-tight font-medium break-words">{node.name}</span>
        {stage ? (
          <span className="text-muted-foreground text-[10px] leading-none">Deterministic</span>
        ) : null}
      </span>
      <span className="text-muted-foreground col-start-2 row-start-1 justify-self-end text-[10px] tracking-wide uppercase">
        Planned
      </span>
    </button>
  );
}

function Terminal({ children }: { children: ReactNode }) {
  return (
    <span className="text-muted-foreground bg-background ring-border/80 rounded-full px-2.5 py-0.5 font-mono text-[10px] tracking-widest uppercase ring-1">
      {children}
    </span>
  );
}

function Cell({
  c,
  r,
  className,
  children,
}: {
  c: string;
  r: string;
  className?: string;
  children?: ReactNode;
}) {
  const style: CSSProperties = { gridColumn: c, gridRow: r };
  return (
    <div style={style} className={cn('relative z-10 min-w-0', className)}>
      {children}
    </div>
  );
}

interface DiagramProps {
  selected: NodeId | null;
  onSelect: (id: NodeId) => void;
}

/** Horizontal composition (tablet and up): two lanes between the fork and the join. */
function WideDiagram({ selected, onSelect }: DiagramProps) {
  const node = (id: NodeId, c: string, r: string) => (
    <Cell key={id} c={c} r={r} className="py-4">
      <NodeButton node={nodeById(id)} selected={selected === id} onSelect={onSelect} />
    </Cell>
  );
  const link = (c: string) => (
    <Cell key={c} c={c} r="2">
      <HLine className="inset-x-0 top-1/2" />
      <Arrow dir="right" className="top-1/2 right-0 -translate-y-1/2" />
    </Cell>
  );
  return (
    <div
      className={cn(
        'grid pt-3 pb-1',
        'grid-cols-[minmax(0,1fr)_1.25rem_minmax(0,1fr)_1rem_minmax(0,1fr)_1rem_minmax(0,1fr)_1rem_minmax(0,1fr)_1.25rem_minmax(0,1fr)]',
        'grid-rows-[auto_auto_2rem_auto_auto]',
      )}
    >
      {/* Nodes, in logical (tab) order. */}
      {node('pre', '1', '2')}
      {node('a1', '3', '1')}
      {node('a2', '3', '2')}
      {node('a3', '5', '2')}
      {node('a4', '7', '2')}
      {node('a5', '9', '2')}
      {node('a6', '11', '2')}
      {node('a7', '11', '4')}

      {/* Parallel lanes. */}
      <div
        aria-hidden
        style={{ gridColumn: '3 / 10', gridRow: '1' }}
        className="bg-muted/50 ring-border/70 relative my-1 rounded-2xl ring-1"
      >
        <span className="text-muted-foreground bg-background absolute -top-2 left-3 rounded px-1.5 text-[10px] tracking-wide uppercase">
          Branch 1 · independent
        </span>
      </div>
      <div
        aria-hidden
        style={{ gridColumn: '3 / 10', gridRow: '2' }}
        className="bg-muted/50 ring-border/70 relative my-1 rounded-2xl ring-1"
      >
        <span className="text-muted-foreground bg-background absolute -top-2 left-3 rounded px-1.5 text-[10px] tracking-wide uppercase">
          Branch 2 · transcript to validation
        </span>
      </div>

      {/* START into Preprocessing. */}
      <Cell c="1" r="1" className="flex items-center justify-center">
        <Terminal>Start</Terminal>
        <VLine className="top-[calc(50%+0.75rem)] bottom-[-1rem] left-1/2" />
        <Arrow dir="down" className="bottom-[-1rem] left-1/2 -translate-x-1/2" />
      </Cell>

      {/* Fork. */}
      <Cell c="2" r="1">
        <HLine className="top-1/2 right-0 left-1/2" />
        <Arrow dir="right" className="top-1/2 right-0 -translate-y-1/2" />
        <VLine className="top-1/2 bottom-0 left-1/2" />
      </Cell>
      <Cell c="2" r="2">
        <HLine className="inset-x-0 top-1/2" />
        <Arrow dir="right" className="top-1/2 right-0 -translate-y-1/2" />
        <VLine className="top-0 left-1/2 h-1/2" />
        <span
          aria-hidden
          className="bg-primary absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
        />
      </Cell>

      {/* A2 to A5. */}
      {link('4')}
      {link('6')}
      {link('8')}

      {/* A1 runs alongside and does not feed A3–A5. */}
      <Cell c="4 / 10" r="1">
        <HLine className="inset-x-0 top-1/2" />
        <span className="text-muted-foreground absolute inset-x-0 top-1/2 px-2 pb-1 text-center text-[11px] leading-tight -translate-y-full">
          Diagnostics only. A1 does not feed A3–A5.
        </span>
      </Cell>

      {/* Join. */}
      <Cell c="10" r="1">
        <HLine className="top-1/2 right-1/2 left-0" />
        <VLine className="top-1/2 bottom-0 left-1/2" />
      </Cell>
      <Cell c="10" r="2">
        <HLine className="top-1/2 right-0 left-0" />
        <Arrow dir="right" className="top-1/2 right-0 -translate-y-1/2" />
        <VLine className="top-0 left-1/2 h-1/2" />
        <span
          aria-hidden
          className="bg-primary ring-background absolute top-1/2 left-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[3px] ring-2"
        />
      </Cell>
      <Cell c="11" r="1" className="flex items-center pl-2">
        <span className="text-muted-foreground text-[11px] leading-tight">
          Join: waits for A1 and A5
        </span>
      </Cell>

      {/* Retry loop A5 to A4. */}
      <Cell c="7 / 10" r="3">
        <span
          aria-hidden
          className={cn(
            'absolute top-[-1rem] right-[calc((100%-1rem)/4)] left-[calc((100%-1rem)/4)] h-8 rounded-b-xl border-x-[1.5px] border-b-[1.5px]',
            TONE_BORDER.retry,
          )}
        />
        <Arrow
          dir="up"
          tone="retry"
          className="top-[-1rem] left-[calc((100%-1rem)/4)] -translate-x-1/2"
        />
      </Cell>
      <Cell
        c="7 / 10"
        r="4"
        className="text-primary px-1 pt-1 text-center text-[11px] leading-tight"
      >
        <span aria-hidden className="mr-1 font-mono">
          &#8634;
        </span>
        {RETRY_LABEL}
      </Cell>

      {/* A6 to A7, with the proposed revision edge. */}
      <Cell c="11" r="3">
        <VLine className="top-[-1rem] bottom-[-1rem] left-[30%]" />
        <Arrow dir="down" className="bottom-[-1rem] left-[30%] -translate-x-1/2" />
        <VLine tone="proposed" className="top-[-1rem] bottom-[-1rem] left-[70%]" />
        <Arrow dir="up" tone="proposed" className="top-[-1rem] left-[70%] -translate-x-1/2" />
      </Cell>

      {/* A7 to END, and the proposed edge label. */}
      <Cell c="11" r="5" className="flex h-9 items-center justify-center">
        <VLine className="top-[-1rem] bottom-[calc(50%+0.75rem)] left-1/2" />
        <Arrow dir="down" className="top-[calc(50%-1.375rem)] left-1/2 -translate-x-1/2" />
        <Terminal>End</Terminal>
      </Cell>
      <Cell
        c="6 / 11"
        r="5"
        className="text-warning flex items-center justify-end pr-2 text-right text-[11px] leading-tight"
      >
        <span>Dashed edge A7 to A6 (possible revision): {PROPOSED_LABEL}</span>
      </Cell>
    </div>
  );
}

/** Vertical composition (mobile): the fork becomes two side-by-side branch columns. */
function NarrowDiagram({ selected, onSelect }: DiagramProps) {
  const node = (id: NodeId) => (
    <NodeButton node={nodeById(id)} selected={selected === id} onSelect={onSelect} />
  );
  const down = (tone: Tone = 'solid', height = 'h-5', arrow = true) => (
    <span aria-hidden className="relative mx-auto block w-px">
      <span className={cn('block border-l-[1.5px]', height, TONE_BORDER[tone])} />
      {arrow ? (
        <Arrow dir="down" tone={tone} className="-bottom-0.5 left-1/2 -translate-x-1/2" />
      ) : null}
    </span>
  );
  return (
    <div className="grid gap-0 py-1">
      <div className="flex justify-center">
        <Terminal>Start</Terminal>
      </div>
      {down()}
      {node('pre')}
      {down('solid', 'h-3', false)}
      <div
        aria-hidden
        className="border-muted-foreground/50 mx-auto h-3 w-[calc(50%+0.375rem)] rounded-t-xl border-x-[1.5px] border-t-[1.5px]"
      />
      <div className="grid grid-cols-2 gap-x-3">
        <section
          aria-label="Branch 1"
          className="bg-muted/50 ring-border/70 flex min-w-0 flex-col gap-2 rounded-2xl p-2 ring-1"
        >
          <p className="text-muted-foreground text-[10px] tracking-wide uppercase">
            Branch 1 · independent
          </p>
          {node('a1')}
          <p className="text-muted-foreground text-[11px] leading-tight">
            Diagnostics only. A1 does not feed A3–A5.
          </p>
          <span
            aria-hidden
            className="mx-auto mt-auto block min-h-4 flex-1 border-l-[1.5px] border-muted-foreground/50"
          />
        </section>
        <section
          aria-label="Branch 2"
          className="bg-muted/50 ring-border/70 flex min-w-0 flex-col gap-0 rounded-2xl p-2 ring-1"
        >
          <p className="text-muted-foreground mb-2 text-[10px] tracking-wide uppercase">
            Branch 2 · transcript to validation
          </p>
          {node('a2')}
          {down()}
          {node('a3')}
          {down()}
          <div className="relative">
            {node('a4')}
            {down()}
            {node('a5')}
            <span
              aria-hidden
              className={cn(
                'absolute top-[2.375rem] right-[-0.5rem] bottom-[2.375rem] w-2 rounded-r-lg border-y-[1.5px] border-r-[1.5px]',
                TONE_BORDER.retry,
              )}
            />
            <Arrow
              dir="right"
              tone="retry"
              className="top-[2.375rem] right-0 -translate-y-1/2 rotate-180"
            />
          </div>
          <p className="text-primary mt-2 text-[11px] leading-tight">
            <span aria-hidden className="mr-1 font-mono">
              &#8634;
            </span>
            {RETRY_LABEL}
          </p>
          <span
            aria-hidden
            className="mx-auto mt-2 block h-4 border-l-[1.5px] border-muted-foreground/50"
          />
        </section>
      </div>
      <div className="bg-background ring-border/80 mx-auto -mt-px flex w-full items-center justify-center gap-2 rounded-full px-3 py-1 text-[11px] ring-1">
        <span aria-hidden className="bg-primary size-2 rotate-45 rounded-[2px]" />
        Join: waits for A1 and A5
      </div>
      {down()}
      {node('a6')}
      <div className="grid grid-cols-2 gap-x-6 px-[22%]">
        <span aria-hidden className="relative mx-auto block w-px">
          <span className="block h-6 border-l-[1.5px] border-muted-foreground/50" />
          <Arrow dir="down" className="-bottom-0.5 left-1/2 -translate-x-1/2" />
        </span>
        <span aria-hidden className="relative mx-auto block w-px">
          <span className={cn('block h-6 border-l-[1.5px]', TONE_BORDER.proposed)} />
          <Arrow dir="up" tone="proposed" className="-top-0.5 left-1/2 -translate-x-1/2" />
        </span>
      </div>
      {node('a7')}
      <p className="text-warning mt-2 text-center text-[11px] leading-tight">
        Dashed edge A7 to A6 (possible revision): {PROPOSED_LABEL}
      </p>
      {down('solid', 'h-4')}
      <div className="flex justify-center">
        <Terminal>End</Terminal>
      </div>
    </div>
  );
}

/** `matchMedia` subscription; falls back to `false` where unavailable (tests). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window.matchMedia !== 'function') return () => {};
      const mq = window.matchMedia(query);
      mq.addEventListener('change', notify);
      return () => mq.removeEventListener('change', notify);
    },
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    () => false,
  );
}

export function PipelineDiagram(props: DiagramProps) {
  // From 768 px the main column is at least 720 px wide at every sidebar state.
  const wide = useMediaQuery('(min-width: 768px)');
  return (
    <div
      role="group"
      aria-label="Pipeline graph. After preprocessing, audio quality (A1) runs in parallel with the transcription branch (A2 to A5). Reporting (A6) waits for both."
    >
      <span id={EXEC_NOTE_ID} className="sr-only">
        Not connected in this build
      </span>
      {wide ? <WideDiagram {...props} /> : <NarrowDiagram {...props} />}
    </div>
  );
}
