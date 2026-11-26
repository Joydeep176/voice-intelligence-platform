/**
 * Loads A1's input by reference (ADR-0044): the preprocessing version's objective measurements,
 * timeline and level series, plus the Tier 1 measurement set when one exists. Reads only
 * measurement data: there is no access to transcription tables here (AGENT_ARCHITECTURE §2.2).
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { AudioLevelSeries, AudioMeasurementRecord, AudioTimeline } from '@vip/contracts';
import {
  getLatestMeasurementSet,
  getMeasurements,
  getPreprocessing,
  getSetMeasurement,
  type Database,
} from '@vip/db';
import { z } from 'zod';
import type { A1Input, Quantity, QuantitySet, SpeechSeries } from './engine';

export class A1InputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'A1InputError';
  }
}

/** Series files are small (4 h of 1 s blocks is about 0.3 MB); anything larger is refused. */
const MAX_SERIES_BYTES = 32 * 1024 * 1024;
/** 4 h at 100 ms (level series) is 144,000 windows. */
const MAX_SERIES_ENTRIES = 200_000;

const KEY = /^derived\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[A-Za-z0-9/_.-]+\.json$/;

/**
 * Reads a derived JSON object of this workspace from local storage. Only `local://derived/<ws>/...`
 * keys are accepted (no traversal, no other workspace); anything else is refused.
 */
export async function readDerivedJson(
  storageRoot: string,
  uri: string,
  workspaceId: string,
): Promise<unknown> {
  const key = uri.startsWith('local://') ? uri.slice('local://'.length) : null;
  if (!key || !KEY.test(key) || key.includes('..') || !key.startsWith(`derived/${workspaceId}/`))
    throw new A1InputError('A1_SERIES_KEY_INVALID');
  let path: string;
  try {
    // Resolve symlinks and stay under the storage root.
    path = await realpath(join(storageRoot, key));
    const root = await realpath(storageRoot);
    if (!path.startsWith(root + sep)) throw new A1InputError('A1_SERIES_KEY_INVALID');
    if ((await stat(path)).size > MAX_SERIES_BYTES) throw new A1InputError('A1_SERIES_TOO_LARGE');
  } catch (error) {
    if (error instanceof A1InputError) throw error;
    throw new A1InputError('A1_SERIES_UNREADABLE');
  }
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new A1InputError('A1_SERIES_UNREADABLE');
  }
}

function toQuantitySet(record: AudioMeasurementRecord): QuantitySet {
  const quantities: Record<string, Quantity> = {};
  for (const [name, qty] of Object.entries(record.quantities))
    quantities[name] = { value: qty.value, kind: qty.kind };
  return { quantities };
}

/** Tier 1 record written by the measure task (ADR-0045): same quantity shape, schema version 2. */
const Tier1Record = z.object({
  quantities: z.record(
    z.string(),
    z.object({ value: z.number().finite(), kind: z.enum(['measured', 'derived', 'estimate']) }),
  ),
});
const Tier1Series = z.object({
  blockMs: z.number().int().positive(),
  speechMs: z.array(z.number().int().nonnegative()).max(MAX_SERIES_ENTRIES),
  snrDb: z.array(z.number().nullable()).max(MAX_SERIES_ENTRIES),
});

export interface LoadedInput {
  input: A1Input;
  /** Objective Tier 0 records the assessment rests on (returned by the API, FR-3.1). */
  records: AudioMeasurementRecord[];
  measurementSetId: string | null;
}

export async function loadA1Input(
  db: Database,
  storageRoot: string,
  ids: { workspaceId: string; preprocessingId: string },
  options: { tier1Enabled: boolean },
): Promise<LoadedInput> {
  const pre = await getPreprocessing(db, ids.workspaceId, ids.preprocessingId);
  if (!pre || pre.status !== 'succeeded' || pre.canonicalDurationMs === null)
    throw new A1InputError('PREPROCESSING_REQUIRED');

  const rows = await getMeasurements(db, ids.workspaceId, pre.id, { segmentId: null });
  const records = rows
    .map((r) => AudioMeasurementRecord.safeParse(r.measurements))
    .filter((p) => p.success)
    .map((p) => p.data);
  const canonical = records.find((r) => r.source === 'canonical') ?? null;
  const original = records.find((r) => r.source === 'original_decoded') ?? null;

  const timeline = AudioTimeline.safeParse(pre.timeline);
  const seriesUri = (pre.artifacts as { levelSeriesUri?: unknown } | null)?.levelSeriesUri;
  let levelSeries: A1Input['levelSeries'] = null;
  if (typeof seriesUri === 'string') {
    const parsed = AudioLevelSeries.safeParse(
      await readDerivedJson(storageRoot, seriesUri, ids.workspaceId),
    );
    if (parsed.success)
      levelSeries = {
        intervalMs: parsed.data.intervalMs,
        rmsDbfs: parsed.data.rmsDbfs,
        peakDbfs: parsed.data.peakDbfs,
      };
  }

  let tier1: A1Input['tier1'] = { state: 'not_requested' };
  let measurementSetId: string | null = null;
  if (options.tier1Enabled) {
    const set = await getLatestMeasurementSet(db, ids.workspaceId, pre.id);
    if (!set) tier1 = { state: 'pending' };
    else if (set.status === 'failed' || set.status === 'cancelled') {
      tier1 = { state: 'failed' };
      measurementSetId = set.id;
    } else if (set.status !== 'succeeded') tier1 = { state: 'pending' };
    else {
      measurementSetId = set.id;
      const record = await getSetMeasurement(db, ids.workspaceId, set.id);
      const parsed = Tier1Record.safeParse(record?.measurements);
      let series: SpeechSeries | null = null;
      if (set.seriesUri) {
        const s = Tier1Series.safeParse(
          await readDerivedJson(storageRoot, set.seriesUri, ids.workspaceId),
        );
        if (s.success) series = s.data;
      }
      tier1 = parsed.success
        ? { state: 'available', quantities: parsed.data.quantities, series }
        : { state: 'failed' };
    }
  }

  return {
    input: {
      durationMs: pre.canonicalDurationMs,
      canonical: canonical ? toQuantitySet(canonical) : null,
      original: original ? toQuantitySet(original) : null,
      levelSeries,
      timeline: timeline.success
        ? {
            gaps: timeline.data.gaps.map((g) => ({ startMs: g.startMs, durationMs: g.durationMs })),
            decodeErrors: timeline.data.decodeErrors,
          }
        : null,
      tier1,
    },
    records,
    measurementSetId,
  };
}
