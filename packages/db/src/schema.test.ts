import { PreprocessingStatus, RecordingStatus, RunStatus } from '@vip/contracts';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  audioMeasurements,
  audioPreprocessings,
  audioSegments,
  auditEvents,
  consentAttestations,
  pipelineRuns,
  preprocessingStatus,
  recordingStatus,
  recordings,
  runStatus,
  uploadSessions,
} from './schema.js';

describe('schema', () => {
  it('uses the contract enums, so API and DB statuses cannot drift', () => {
    expect(recordingStatus.enumValues).toEqual(RecordingStatus.options);
    expect(runStatus.enumValues).toEqual(RunStatus.options);
  });

  it('defaults new runs to created (ADR-0025) and new recordings to uploading', () => {
    const runStatusCol = getTableConfig(pipelineRuns).columns.find((c) => c.name === 'status');
    const recStatusCol = getTableConfig(recordings).columns.find((c) => c.name === 'status');
    expect(runStatusCol?.default).toBe('created');
    expect(recStatusCol?.default).toBe('uploading');
  });

  it('gives every tenant-owned table a workspace_id (ADR-0003)', () => {
    for (const table of [
      recordings,
      uploadSessions,
      consentAttestations,
      pipelineRuns,
      auditEvents,
    ]) {
      const cols = getTableConfig(table).columns.map((c) => c.name);
      expect(cols).toContain('workspace_id');
    }
  });

  it('keeps duration nullable until determined', () => {
    const col = getTableConfig(recordings).columns.find((c) => c.name === 'duration_ms');
    expect(col?.notNull).toBe(false);
  });

  it('declares the audio tables with workspace_id, composite FKs and the shared status enum', () => {
    expect(preprocessingStatus.enumValues).toEqual(PreprocessingStatus.options);
    for (const table of [audioPreprocessings, audioSegments, audioMeasurements]) {
      const config = getTableConfig(table);
      expect(config.columns.map((c) => c.name)).toContain('workspace_id');
      const composite = config.foreignKeys.filter((fk) => fk.reference().columns.length === 2);
      expect(composite.length).toBeGreaterThanOrEqual(1);
      for (const fk of composite) expect(fk.onDelete).toBe('cascade');
    }
    expect(getTableConfig(audioMeasurements).foreignKeys).toHaveLength(3);
    const mediaProbe = getTableConfig(recordings).columns.find((c) => c.name === 'media_probe');
    expect(mediaProbe?.notNull).toBe(false);
  });
});
