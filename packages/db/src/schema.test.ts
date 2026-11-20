import { RecordingStatus, RunStatus } from '@vip/contracts';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  auditEvents,
  consentAttestations,
  pipelineRuns,
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
});
