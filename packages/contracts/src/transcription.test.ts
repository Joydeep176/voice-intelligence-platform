import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FAKE_PROVIDER_ID,
  JobIds,
  ProcessingStatus,
  QueueName,
  RawOutputList,
  RunConfig,
  RunSnapshot,
  RunTranscriptionJob,
  SpeakerList,
  SpeakerPatch,
  StartRunBody,
  TranscriptPage,
  TranscriptQuery,
  TranscriptSegmentDto,
  UncertaintyList,
  UNCERTAINTY_KINDS,
} from './index.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/transcription/${name}`, import.meta.url), 'utf8'));
const ID = '11111111-1111-4111-8111-111111111111';

describe('transcription contract fixtures', () => {
  it('valid fixtures parse', () => {
    expect(RunSnapshot.safeParse(fixture('run-snapshot.valid.json')).success).toBe(true);
    expect(TranscriptPage.safeParse(fixture('transcript-page.valid.json')).success).toBe(true);
    expect(UncertaintyList.safeParse(fixture('uncertainties.valid.json')).success).toBe(true);
    expect(RawOutputList.safeParse(fixture('raw-outputs.valid.json')).success).toBe(true);
    expect(SpeakerList.safeParse(fixture('speakers.valid.json')).success).toBe(true);
  });

  it('a run snapshot is a superset of ProcessingStatus (existing consumers keep working)', () => {
    const parsed = ProcessingStatus.safeParse(fixture('run-snapshot.valid.json'));
    expect(parsed.success).toBe(true);
  });

  it('the fake provider is marked in the snapshot', () => {
    const snap = RunSnapshot.parse(fixture('run-snapshot.valid.json'));
    expect(snap.providers?.stt.id).toBe(FAKE_PROVIDER_ID);
    expect(snap.providers?.stt.fake).toBe(true);
  });

  it('confidence is nullable but never defaulted', () => {
    const page = TranscriptPage.parse(fixture('transcript-page.valid.json'));
    expect(page.items[0]?.confidence).toBeNull();
    const seg = { ...page.items[0], confidence: 1.5 };
    expect(TranscriptSegmentDto.safeParse(seg).success).toBe(false);
  });

  it('rejects an unknown language, an unknown uncertainty kind and a bad raw hash', () => {
    const page = fixture('transcript-page.valid.json') as { items: Record<string, unknown>[] };
    expect(
      TranscriptPage.safeParse({ ...page, items: [{ ...page.items[0], language: 'fr' }] }).success,
    ).toBe(false);
    const unc = fixture('uncertainties.valid.json') as { items: Record<string, unknown>[] };
    expect(
      UncertaintyList.safeParse({ ...unc, items: [{ ...unc.items[0], kind: 'made_up' }] }).success,
    ).toBe(false);
    const raw = fixture('raw-outputs.valid.json') as { items: Record<string, unknown>[] };
    expect(RawOutputList.safeParse({ items: [{ ...raw.items[0], sha256: 'XYZ' }] }).success).toBe(
      false,
    );
  });

  it('exposes the five uncertainty kinds of DATABASE_DESIGN §4', () => {
    expect([...UNCERTAINTY_KINDS]).toEqual([
      'low_confidence',
      'inaudible',
      'overlapping_speech',
      'language_uncertain',
      'speaker_uncertain',
    ]);
  });
});

describe('request schemas', () => {
  it('speaker patch accepts only displayName (speakerKey immutable)', () => {
    expect(SpeakerPatch.safeParse({ displayName: '  Anna ' }).data).toEqual({
      displayName: 'Anna',
    });
    expect(SpeakerPatch.safeParse({ displayName: 'A', speakerKey: 'X' }).success).toBe(false);
    expect(SpeakerPatch.safeParse({ displayName: '   ' }).success).toBe(false);
    expect(SpeakerPatch.safeParse({ displayName: 'x'.repeat(81) }).success).toBe(false);
  });

  it('start body rejects fields that are not implemented', () => {
    expect(StartRunBody.safeParse({}).success).toBe(true);
    expect(StartRunBody.safeParse({ languageHints: ['en', 'hi'] }).success).toBe(true);
    expect(StartRunBody.safeParse({ sourceTranscriptVersionId: ID }).success).toBe(false);
    expect(StartRunBody.safeParse({ languageHints: ['fr'] }).success).toBe(false);
  });

  it('transcript query coerces and bounds', () => {
    expect(TranscriptQuery.parse({}).limit).toBe(200);
    expect(TranscriptQuery.parse({ fromMs: '10', toMs: '20', version: '1' })).toMatchObject({
      fromMs: 10,
      toMs: 20,
      version: 1,
    });
    expect(TranscriptQuery.safeParse({ limit: '5000' }).success).toBe(false);
    expect(TranscriptQuery.safeParse({ fromMs: '-1' }).success).toBe(false);
  });

  it('run config requires at least one stage', () => {
    expect(RunConfig.safeParse({ schemaVersion: 1, stages: [] }).success).toBe(false);
    expect(RunConfig.safeParse({ schemaVersion: 1, stages: ['transcription'] }).success).toBe(true);
  });
});

describe('run job payload', () => {
  it('carries IDs only; job id is the run id and contains no colon', () => {
    expect(RunTranscriptionJob.safeParse({ workspaceId: ID, runId: ID }).success).toBe(true);
    expect(RunTranscriptionJob.safeParse({ workspaceId: ID }).success).toBe(false);
    expect(JobIds.run(ID)).toBe(ID);
    expect(QueueName.RunTranscription).toBe('run-transcription');
  });
});
