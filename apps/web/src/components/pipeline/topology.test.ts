import { describe, expect, it } from 'vitest';
import { EDGES, feeds, NODES, nodeById, type NodeId } from './topology';

const normal = EDGES.filter((e) => e.kind === 'normal');
const into = (id: string) => normal.filter((e) => e.to === id).map((e) => e.from);
const out = (id: string) => normal.filter((e) => e.from === id).map((e) => e.to);

describe('pipeline topology', () => {
  it('has seven agents A1-A7 and preprocessing as a deterministic non-agent', () => {
    const agents = NODES.filter((n) => n.kind === 'agent');
    expect(agents.map((n) => n.code)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']);
    expect(NODES).toHaveLength(8);
    const pre = nodeById('pre');
    expect(pre.kind).toBe('deterministic');
    expect(pre.responsibility).toMatch(/not an agent/i);
  });

  it('has unique node ids and every edge endpoint exists', () => {
    const ids = new Set(NODES.map((n) => n.id));
    expect(ids.size).toBe(NODES.length);
    for (const e of EDGES) {
      for (const end of [e.from, e.to]) {
        expect(end === 'start' || end === 'end' || ids.has(end as NodeId)).toBe(true);
      }
    }
  });

  it('branches A1 and A2 in parallel from preprocessing', () => {
    expect(out('pre').sort()).toEqual(['a1', 'a2']);
    expect(into('a1')).toEqual(['pre']);
    expect(into('a2')).toEqual(['pre']);
    expect(feeds('pre')).toEqual(['A1 Audio Quality', 'A2 Transcription']);
  });

  it('keeps audio quality off the transcription chain', () => {
    expect(out('a1')).toEqual(['a6']);
    expect(into('a3')).toEqual(['a2']);
  });

  it('joins at A6, which waits for A1 and A5 only', () => {
    expect(into('a6').sort()).toEqual(['a1', 'a5']);
    expect(into('a7')).toEqual(['a6']);
  });

  it('has exactly one retry edge, A5 to A4', () => {
    const retries = EDGES.filter((e) => e.kind === 'retry');
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ from: 'a5', to: 'a4' });
    expect(retries[0]?.label).toMatch(/one targeted research retry/i);
  });

  it('marks A7 to A6 as proposed (OD-14), not decided', () => {
    const proposed = EDGES.filter((e) => e.kind === 'proposed');
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ from: 'a7', to: 'a6' });
    expect(proposed[0]?.label).toMatch(/Proposed.*not decided/);
    expect(nodeById('a7').references.join(' ')).toMatch(/OD-14 \(Proposed\)/);
  });

  it('carries no runtime status: every node is only planned', () => {
    expect(NODES.every((n) => n.capability === 'planned')).toBe(true);
  });

  it('makes A7 read-only on the report (writes QA records only)', () => {
    expect(nodeById('a7').mayWrite).toBe('QA reviews and QA issues only');
  });
});
