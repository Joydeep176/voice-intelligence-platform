/**
 * Pipeline topology, transcribed from docs/architecture/AGENT_ARCHITECTURE.md §1 and §2. The diagram,
 * the agent panel and the list view all read from this module. It describes the designed graph only:
 * no agent executes in this build, so nothing here carries runtime status.
 */

export type NodeId = 'pre' | 'a1' | 'a2' | 'a3' | 'a4' | 'a5' | 'a6' | 'a7';
export type Terminal = 'start' | 'end';
export type NodeKind = 'agent' | 'deterministic';
export type Capability = 'planned';

export interface PipelineNode {
  id: NodeId;
  /** "PRE" or A1..A7. */
  code: string;
  name: string;
  kind: NodeKind;
  responsibility: string;
  inputs: string[];
  outputs: string[];
  /** Upstream nodes that must have completed before this one starts. */
  waitsFor: string;
  /** Write boundary: the only data this node may write. */
  mayWrite: string;
  /** ADR / FR / OD identifiers as plain text. */
  references: string[];
  capability: Capability;
}

export type EdgeKind = 'normal' | 'retry' | 'proposed';

export interface PipelineEdge {
  from: NodeId | Terminal;
  to: NodeId | Terminal;
  kind: EdgeKind;
  label?: string;
}

export const NODES: readonly PipelineNode[] = [
  {
    id: 'pre',
    code: 'PRE',
    name: 'Preprocessing',
    kind: 'deterministic',
    responsibility:
      'Deterministic audio-service stage: decode, normalise, voice-activity detection and segmentation. It transforms and measures audio and makes no quality judgements. It is not an agent.',
    inputs: ['Recording'],
    outputs: ['Preprocessing version', 'Audio segments'],
    waitsFor: 'Start of run',
    mayWrite: 'Preprocessing records and audio segments',
    references: ['ADR-0019', 'ADR-0015', 'OD-29'],
    capability: 'planned',
  },
  {
    id: 'a1',
    code: 'A1',
    name: 'Audio Quality',
    kind: 'agent',
    responsibility:
      'Signal diagnostics: noise, clipping, distortion. Poor quality does not stop the run. Runs in parallel with the transcription branch and never reads transcription data.',
    inputs: ['Preprocessing version'],
    outputs: ['Overall verdict', 'Flags with severity and timestamps', 'Summary'],
    waitsFor: 'Preprocessing',
    mayWrite: 'Audio-quality diagnostics only',
    references: ['ADR-0008', 'ADR-0021', 'FR-9.3'],
    capability: 'planned',
  },
  {
    id: 'a2',
    code: 'A2',
    name: 'Transcription',
    kind: 'agent',
    responsibility:
      'Speech-to-text, language identification, diarization, speaker alignment and transcription uncertainty. Never modifies raw provider output and never reads audio diagnostics.',
    inputs: ['Preprocessing version (segments)'],
    outputs: ['Raw provider outputs', 'Machine transcript version', 'Speakers', 'Uncertainties'],
    waitsFor: 'Preprocessing',
    mayWrite: 'Transcript versions and transcription uncertainty only',
    references: ['ADR-0007', 'ADR-0012', 'ADR-0016', 'ADR-0021'],
    capability: 'planned',
  },
  {
    id: 'a3',
    code: 'A3',
    name: 'Context Intelligence',
    kind: 'agent',
    responsibility:
      'Topics, entities and claims. Keeps verbatim quotation separate from interpretation. Waits for A2 only, not A1.',
    inputs: ['Transcript version'],
    outputs: ['Topics (inferred)', 'Entities', 'Claims with verbatim quoted text'],
    waitsFor: 'A2 Transcription',
    mayWrite: 'Topics, entities and claims only',
    references: ['ADR-0020', 'ADR-0021'],
    capability: 'planned',
  },
  {
    id: 'a4',
    code: 'A4',
    name: 'Research',
    kind: 'agent',
    responsibility:
      'Gathers external evidence for claims. Always runs. The only agent that sends data to the research provider, with minimised queries.',
    inputs: ['Claims', 'Context'],
    outputs: ['Queries exactly as sent', 'Sources with snapshots'],
    waitsFor: 'A3 Context Intelligence',
    mayWrite: 'Research queries and sources only',
    references: ['ADR-0009', 'ADR-0014', 'ADR-0017'],
    capability: 'planned',
  },
  {
    id: 'a5',
    code: 'A5',
    name: 'Fact Validation',
    kind: 'agent',
    responsibility:
      'Checks claims against snapshot evidence. Snippet-only sources never support a verdict. May trigger one targeted research retry per run.',
    inputs: ['Claims', 'Sources'],
    outputs: ['Evidence links', 'Validations'],
    waitsFor: 'A4 Research (and its targeted retry, if triggered)',
    mayWrite: 'Claim evidence and validations only',
    references: ['ADR-0014', 'FR-8.2', 'OD-30 (Proposed)'],
    capability: 'planned',
  },
  {
    id: 'a6',
    code: 'A6',
    name: 'Reporting',
    kind: 'agent',
    responsibility:
      'Produces the evidence-backed report. Every assertion carries recorded, external or inferred provenance. Keeps audio limitations and transcription uncertainty as separate sections. The only join of the two branches.',
    inputs: ['All artefacts', 'Report language'],
    outputs: ['Versioned report', 'Assertions with provenance and references'],
    waitsFor: 'A1 and A5 (and therefore A2 to A4)',
    mayWrite: 'Reports, assertions and assertion references only',
    references: ['ADR-0006', 'FR-9.2', 'FR-9.3'],
    capability: 'planned',
  },
  {
    id: 'a7',
    code: 'A7',
    name: 'QA',
    kind: 'agent',
    responsibility:
      'Independent and read-only. Checks provenance, reference resolution, quote fidelity, evidence sufficiency, section separation and report language. Never edits the report.',
    inputs: ['Report', 'All artefacts'],
    outputs: ['Pass or fail', 'Issues'],
    waitsFor: 'A6 Reporting',
    mayWrite: 'QA reviews and QA issues only',
    references: ['OD-14 (Proposed)'],
    capability: 'planned',
  },
];

export const RETRY_LABEL = 'One targeted research retry per run (ADR-0014)';
export const PROPOSED_LABEL = 'Proposed (OD-14), not decided';

export const EDGES: readonly PipelineEdge[] = [
  { from: 'start', to: 'pre', kind: 'normal' },
  { from: 'pre', to: 'a1', kind: 'normal' },
  { from: 'pre', to: 'a2', kind: 'normal' },
  { from: 'a2', to: 'a3', kind: 'normal' },
  { from: 'a3', to: 'a4', kind: 'normal' },
  { from: 'a4', to: 'a5', kind: 'normal' },
  { from: 'a1', to: 'a6', kind: 'normal' },
  { from: 'a5', to: 'a6', kind: 'normal' },
  { from: 'a6', to: 'a7', kind: 'normal' },
  { from: 'a7', to: 'end', kind: 'normal' },
  { from: 'a5', to: 'a4', kind: 'retry', label: RETRY_LABEL },
  { from: 'a7', to: 'a6', kind: 'proposed', label: PROPOSED_LABEL },
];

const BY_ID = new Map(NODES.map((n) => [n.id, n]));
export const nodeById = (id: NodeId): PipelineNode => BY_ID.get(id)!;

export const nodeLabel = (n: PipelineNode) => `${n.code} ${n.name}`;

/** Downstream nodes along normal edges (the retry and proposed edges are listed separately). */
export function feeds(id: NodeId): string[] {
  return EDGES.filter((e) => e.kind === 'normal' && e.from === id && e.to !== 'end').map((e) =>
    nodeLabel(nodeById(e.to as NodeId)),
  );
}

export const KIND_LABEL: Record<NodeKind, string> = {
  agent: 'Agent',
  deterministic: 'Deterministic stage (not an agent)',
};
