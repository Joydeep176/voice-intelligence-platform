/**
 * The A1 node (ADR-0044, D-3A-02): one framework-independent function over the contract types.
 * Phase 3A runs it from a BullMQ job; the shared LangGraph graph will call the same function.
 * It loads by reference, assesses deterministically and writes only A1's own tables, keyed by
 * (run, attempt) so a redelivered job is idempotent. It returns the state slice only.
 */
import { A1NodeInput, A1NodeOutput, type AudioQualityStateSlice } from '@vip/contracts';
import { insertDiagnostics, type Database } from '@vip/db';
import { assess } from './engine';
import { loadA1Input } from './inputs';
import type { A1RuleConfig } from './rule-config';

export interface A1Ports {
  db: Database;
  storageRoot: string;
  rules: A1RuleConfig;
  tier1Enabled: boolean;
  /** Checked right before the write: a cancelled run gets no diagnostics (lifecycle L5). */
  isCancelled: () => Promise<boolean>;
}

export class A1Cancelled extends Error {
  constructor() {
    super('A1_CANCELLED');
    this.name = 'A1Cancelled';
  }
}

export async function runAudioQuality(
  rawInput: A1NodeInput,
  attempt: number,
  ports: A1Ports,
): Promise<A1NodeOutput> {
  const input = A1NodeInput.parse(rawInput);
  const loaded = await loadA1Input(
    ports.db,
    ports.storageRoot,
    { workspaceId: input.workspaceId, preprocessingId: input.preprocessingId },
    { tier1Enabled: ports.tier1Enabled },
  );
  const out = assess(loaded.input, ports.rules);
  if (await ports.isCancelled()) throw new A1Cancelled();
  const { diagnostics } = await insertDiagnostics(ports.db, {
    workspaceId: input.workspaceId,
    runId: input.runId,
    preprocessingId: input.preprocessingId,
    measurementSetId: loaded.measurementSetId,
    attempt,
    ruleVersion: ports.rules.ruleVersion,
    provisional: ports.rules.provisional,
    overall: out.overall,
    confidence: out.confidence,
    suitability: out.suitability,
    notAssessed: out.notAssessed,
    recommendations: out.recommendations,
    affectedRatio: out.affectedRatio,
    tier1: out.tier1,
    ruleConfig: ports.rules as unknown as Record<string, unknown>,
    flags: out.flags,
  });
  const stateSlice: AudioQualityStateSlice = {
    diagnosticsId: diagnostics.id,
    overall: diagnostics.overall,
    confidence: diagnostics.confidence,
  };
  return A1NodeOutput.parse({ diagnosticsId: diagnostics.id, stateSlice });
}
