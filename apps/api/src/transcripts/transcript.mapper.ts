import {
  FAKE_PROVIDER_ID,
  RunConfig,
  type RawOutputDto,
  type SpeakerDto,
  type TranscriptSegmentDto,
  type TranscriptVersionDto,
  type UncertaintyDto,
} from '@vip/contracts';
import type {
  DiarizationRawOutput,
  Speaker,
  SttRawOutput,
  TranscriptionUncertainty,
  TranscriptSegment,
  TranscriptVersion,
} from '@vip/db';

export const toVersionDto = (
  v: TranscriptVersion & { segmentCount: number },
): TranscriptVersionDto => ({
  id: v.id,
  version: v.version,
  kind: v.kind,
  baseVersionId: v.baseVersionId,
  createdBy: v.createdBy,
  note: v.note,
  createdAt: v.createdAt.toISOString(),
  segmentCount: v.segmentCount,
});

export const toSegmentDto = (s: TranscriptSegment): TranscriptSegmentDto => ({
  id: s.id,
  speakerId: s.speakerId,
  startMs: s.startMs,
  endMs: s.endMs,
  text: s.text,
  language: s.language,
  codeSwitchSpans: s.codeSwitchSpans,
  confidence: s.confidence,
  words: s.words,
});

export const toUncertaintyDto = (u: TranscriptionUncertainty): UncertaintyDto => ({
  id: u.id,
  segmentId: u.segmentId,
  startMs: u.startMs,
  endMs: u.endMs,
  kind: u.kind,
  score: u.score,
});

export const toSpeakerDto = (s: Speaker): SpeakerDto => ({
  id: s.id,
  speakerKey: s.speakerKey,
  displayName: s.displayName,
  totalSpeechMs: s.totalSpeechMs,
});

/** Metadata only: the storage URI is internal and never exposed. */
export const toSttRawDto = (r: SttRawOutput): RawOutputDto => ({
  id: r.id,
  kind: 'stt',
  provider: r.provider,
  providerModel: r.providerModel,
  scope: 'window',
  windowIndex: r.windowIndex,
  windowStartMs: r.windowStartMs,
  windowEndMs: r.windowEndMs,
  sha256: r.sha256,
  receivedAt: r.receivedAt.toISOString(),
  fake: r.provider === FAKE_PROVIDER_ID,
});

export const toDiarizationRawDto = (r: DiarizationRawOutput): RawOutputDto => ({
  id: r.id,
  kind: 'diarization',
  provider: r.provider,
  providerModel: r.providerModel,
  scope: r.scope,
  windowIndex: null,
  windowStartMs: r.windowStartMs,
  windowEndMs: r.windowEndMs,
  sha256: r.sha256,
  receivedAt: r.receivedAt.toISOString(),
  fake: r.provider === FAKE_PROVIDER_ID,
});

/** Window source and providers recorded on the run (null until the run started). */
export function runContext(config: unknown) {
  const parsed = RunConfig.safeParse(config);
  return {
    windowSource: parsed.success ? (parsed.data.window?.source ?? null) : null,
    providers: parsed.success ? (parsed.data.providers ?? null) : null,
  };
}

/** Opaque keyset cursor over (startMs, id). */
export function encodeCursor(row: { startMs: number; id: string }): string {
  return Buffer.from(JSON.stringify([row.startMs, row.id]), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { startMs: number; id: string } | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      Number.isInteger(value[0]) &&
      (value[0] as number) >= 0 &&
      typeof value[1] === 'string' &&
      /^[0-9a-f-]{36}$/.test(value[1])
    ) {
      return { startMs: value[0] as number, id: value[1] };
    }
  } catch {
    // fall through
  }
  return null;
}
