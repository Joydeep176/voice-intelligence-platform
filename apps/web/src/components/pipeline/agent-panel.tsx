import { CircleDashed, CircleSlash } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { SURFACE } from './surface';
import { feeds, KIND_LABEL, type PipelineNode } from './topology';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {label}
      </dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

const List = ({ items }: { items: string[] }) => (
  <ul className="grid list-disc gap-0.5 pl-4">
    {items.map((t) => (
      <li key={t}>{t}</li>
    ))}
  </ul>
);

/** Details for the selected node. The heading is a focus target so keyboard users can jump here. */
export function AgentPanel({
  node,
  headingRef,
  onBack,
  showBack,
}: {
  node: PipelineNode | null;
  headingRef: Ref<HTMLHeadingElement>;
  onBack: () => void;
  showBack: boolean;
}) {
  if (!node) {
    return (
      <section aria-label="Agent panel" className={cn(SURFACE, 'grid gap-1 p-4')}>
        <h2 ref={headingRef} tabIndex={-1} className="text-lg font-medium outline-none">
          Agent panel
        </h2>
        <p className="text-muted-foreground text-sm">
          Select a stage in the diagram to see its contract.
        </p>
      </section>
    );
  }
  const downstream = feeds(node.id);
  return (
    <section aria-labelledby="agent-panel-title" className={cn(SURFACE, 'grid gap-4 p-4')}>
      <header className="grid gap-1">
        <h2
          id="agent-panel-title"
          ref={headingRef}
          tabIndex={-1}
          className="focus-visible:ring-ring/50 rounded-sm text-lg leading-snug font-medium outline-none focus-visible:ring-3"
        >
          <span className="text-primary mr-2 font-mono text-sm">{node.code}</span>
          {node.name}
        </h2>
        <p className="text-muted-foreground text-sm">{KIND_LABEL[node.kind]}</p>
        <div className="flex flex-wrap gap-1.5 pt-1">
          <span className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium">
            <CircleDashed aria-hidden className="size-3" />
            Capability: Planned
          </span>
          <span className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium">
            <CircleSlash aria-hidden className="size-3" />
            Execution: Not connected in this build
          </span>
        </div>
      </header>
      <dl className="grid gap-4">
        <Field label="Responsibility">{node.responsibility}</Field>
        <Field label="Inputs">
          <List items={node.inputs} />
        </Field>
        <Field label="Outputs">
          <List items={node.outputs} />
        </Field>
        <Field label="Waits for">{node.waitsFor}</Field>
        <Field label="Feeds">{downstream.length ? downstream.join(', ') : 'End of run'}</Field>
        <Field label="May write (boundary)">{node.mayWrite}</Field>
        <Field label="References">
          <ul className="flex flex-wrap gap-1.5">
            {node.references.map((r) => (
              <li
                key={r}
                className="bg-secondary text-secondary-foreground rounded-md px-1.5 py-0.5 font-mono text-[11px]"
              >
                {r}
              </li>
            ))}
          </ul>
        </Field>
      </dl>
      {showBack ? (
        <Button variant="outline" size="sm" className="w-fit" onClick={onBack}>
          Back to diagram
        </Button>
      ) : null}
    </section>
  );
}
