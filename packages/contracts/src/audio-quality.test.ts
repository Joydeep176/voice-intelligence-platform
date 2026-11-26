import { describe, expect, it } from 'vitest';
import {
  A1NodeInput,
  AUDIO_QUALITY_CLASSES,
  AudioDiagnosticFlag,
  AudioDiagnosticsSnapshot,
  AudioQualityContext,
  AudioQualitySummary,
  DIAGNOSTIC_FLAG_KINDS,
  RUN_STAGES,
  STAGE_NODES,
} from './index.js';
import { AudioMeasureJob, JobIds, QueueName, RunAudioQualityJob } from './jobs.js';

const ID = '00000000-0000-4000-8000-000000000001';

const summary = {
  schemaVersion: 1,
  diagnosticsId: ID,
  runId: ID,
  preprocessingId: ID,
  ruleVersion: 'a1-rules-0.1-provisional',
  provisional: true,
  overall: 'acceptable_with_warnings',
  confidence: 'medium',
  suitability: {
    transcription: { value: 'limited', reasons: ['noise'] },
    diarization: { value: 'suitable', reasons: [] },
  },
  flagCounts: { noise: { medium: 1 } },
  affectedRatio: 0.25,
  notAssessed: [{ dimension: 'reverberation', reason: 'not_supported_v1' }],
  tier1: 'available',
  createdAt: '2026-11-26T12:00:00.000Z',
} as const;

const flag = {
  id: ID,
  kind: 'noise',
  severity: 'medium',
  startMs: 0,
  endMs: 1000,
  basis: 'estimate',
  ruleId: 'noise.snr',
  measurementRefs: [{ quantity: 'blockSnrDb', series: 'speech', fromIndex: 0, toIndex: 1 }],
} as const;

describe('A1 contracts (ADR-0043 / ADR-0046)', () => {
  it('keeps RUN_STAGES as the transcription scope and adds audio_quality only as a stage node', () => {
    expect(RUN_STAGES).toEqual(['transcription', 'diarization']);
    expect(STAGE_NODES).toEqual(['transcription', 'diarization', 'audio_quality']);
  });

  it('has the accepted four classes and flag kinds', () => {
    expect(AUDIO_QUALITY_CLASSES).toEqual([
      'good',
      'acceptable_with_warnings',
      'poor',
      'insufficient',
    ]);
    expect(DIAGNOSTIC_FLAG_KINDS).toContain('fragmented_speech');
    expect(DIAGNOSTIC_FLAG_KINDS).toContain('distortion');
  });

  it('parses a summary and rejects the old classes and unknown keys', () => {
    expect(AudioQualitySummary.parse(summary).overall).toBe('acceptable_with_warnings');
    expect(() => AudioQualitySummary.parse({ ...summary, overall: 'degraded' })).toThrow();
    expect(() => AudioQualitySummary.parse({ ...summary, probability: 0.9 })).toThrow();
    expect(() => AudioQualitySummary.parse({ ...summary, affectedRatio: 1.5 })).toThrow();
  });

  it('parses flags; whole-recording flags have null bounds', () => {
    expect(AudioDiagnosticFlag.parse(flag).kind).toBe('noise');
    expect(AudioDiagnosticFlag.parse({ ...flag, startMs: null, endMs: null }).startMs).toBeNull();
    expect(() => AudioDiagnosticFlag.parse({ ...flag, kind: 'machinery' })).toThrow();
  });

  it('exposes only kind, severity and range of flags in the read context', () => {
    const ctx = AudioQualityContext.parse({
      summary,
      flags: [{ kind: 'noise', severity: 'low', startMs: 0, endMs: 10 }],
    });
    expect(Object.keys(ctx.flags[0]!).sort()).toEqual(['endMs', 'kind', 'severity', 'startMs']);
    expect(() => AudioQualityContext.parse({ summary, flags: [{ ...flag }] })).toThrow(); // rule ids and measurement refs are not part of the read view
  });

  it('parses the API snapshot with and without diagnostics', () => {
    expect(
      AudioDiagnosticsSnapshot.parse({
        runId: ID,
        state: 'pending',
        stage: null,
        measurementSet: { status: 'running', error: null },
        diagnostics: null,
      }).state,
    ).toBe('pending');
  });

  it('carries IDs only in node inputs and job payloads', () => {
    expect(() =>
      A1NodeInput.parse({
        workspaceId: ID,
        runId: ID,
        preprocessingId: ID,
        measurementSetId: null,
      }),
    ).not.toThrow();
    expect(RunAudioQualityJob.parse({ workspaceId: ID, runId: ID, attempt: 1 }).attempt).toBe(1);
    expect(AudioMeasureJob.parse({ workspaceId: ID, measurementSetId: ID }).measurementSetId).toBe(
      ID,
    );
    expect(QueueName.RunAudioQuality).toBe('run-audio-quality');
    expect(JobIds.audioQuality(ID, 2)).toBe(`aq-${ID}-2`);
    expect(JobIds.measure(ID)).not.toContain(':');
  });
});
