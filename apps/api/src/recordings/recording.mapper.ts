import type { ProcessingStatus, RecordingMetadata, UploadSession } from '@vip/contracts';
import type { PipelineRun, Recording, UploadSessionRow } from '@vip/db';

export function toProcessingStatus(run: PipelineRun): ProcessingStatus {
  return {
    id: run.id,
    recordingId: run.recordingId,
    status: run.status,
    currentStage: run.currentNode,
    error: run.error ?? null,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

/** Storage URIs and validation internals are intentionally not mapped. */
export function toRecordingMetadata(
  rec: Recording,
  latestRun: PipelineRun | null,
): RecordingMetadata {
  return {
    id: rec.id,
    workspaceId: rec.workspaceId,
    originalFilename: rec.originalFilename,
    mimeType: rec.mimeType,
    sizeBytes: rec.sizeBytes,
    durationMs: rec.durationMs,
    sha256: rec.sha256,
    status: rec.status,
    createdAt: rec.createdAt.toISOString(),
    updatedAt: rec.updatedAt.toISOString(),
    latestRun: latestRun ? toProcessingStatus(latestRun) : null,
  };
}

export function toUploadSession(row: UploadSessionRow): UploadSession {
  return {
    strategy: row.strategy,
    status: row.status,
    partSize: row.partSize,
    totalParts: row.totalParts,
    partsReceived: Object.entries(row.partsReceived)
      .map(([n, v]) => ({ partNumber: Number(n), sizeBytes: v.sizeBytes }))
      .sort((a, b) => a.partNumber - b.partNumber),
    expiresAt: row.expiresAt.toISOString(),
  };
}
