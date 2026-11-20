import {
  EDGES,
  feeds,
  KIND_LABEL,
  NODES,
  nodeLabel,
  PROPOSED_LABEL,
  RETRY_LABEL,
} from './topology';
import type { NodeId } from './topology';

/** Extra structure that only the drawing shows, spelled out for screen readers. */
const NOTES: Partial<Record<NodeId, string>> = {
  a1: 'Runs in parallel with A2 to A5. Does not feed A3–A5.',
  a2: 'Runs in parallel with A1.',
  a5: `Loop back to A4: ${RETRY_LABEL}.`,
  a6: 'The only join of the two branches. Waits for A1 and A5.',
  a7: `Ends the run. Possible revision back to A6: ${PROPOSED_LABEL}.`,
};

const WAITS: Record<NodeId, string[]> = Object.fromEntries(
  NODES.map((n) => [
    n.id,
    EDGES.filter((e) => e.kind === 'normal' && e.to === n.id).map((e) =>
      e.from === 'start' ? 'Start' : nodeLabel(NODES.find((x) => x.id === e.from)!),
    ),
  ]),
) as Record<NodeId, string[]>;

/** Text alternative to the diagram: every stage, its kind and its dependencies, in order. */
export function PipelineListView() {
  return (
    <details className="bg-card ring-foreground/10 rounded-xl p-4 text-sm shadow-sm ring-1">
      <summary className="focus-visible:ring-ring/50 cursor-pointer rounded-sm text-sm font-semibold outline-none focus-visible:ring-3">
        List view (text alternative to the diagram)
      </summary>
      <ol aria-label="Pipeline stages and dependencies" className="mt-4 grid gap-3">
        {NODES.map((n) => {
          const next = feeds(n.id);
          return (
            <li key={n.id} className="grid gap-0.5">
              <p className="font-medium">
                {nodeLabel(n)}
                <span className="text-muted-foreground ml-2 text-xs font-normal">
                  {KIND_LABEL[n.kind]} · Planned · Not connected
                </span>
              </p>
              <p className="text-muted-foreground">
                Waits for: {WAITS[n.id].join(' and ')}. Feeds:{' '}
                {next.length ? next.join(', ') : 'end of run'}.
                {NOTES[n.id] ? ` ${NOTES[n.id]}` : ''}
              </p>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
