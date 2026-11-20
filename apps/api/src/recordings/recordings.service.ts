import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  CreateRecordingRequest,
  RecordingList,
  RecordingMetadata,
  RecordingUploadResponse,
  UploadPartResponse,
  UploadSession,
} from '@vip/contracts';
import type { Recording, UploadSessionRow } from '@vip/db';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { AuditService } from '../audit/audit.service';
import type { Principal } from '../auth/principal';
import { AppException } from '../common/app-exception';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { ObjectTooLargeError, StorageKeys, StorageService } from '../storage/storage.service';
import { SIGNATURE_BYTES, signatureMatches } from './media-signature';
import { toRecordingMetadata, toUploadSession } from './recording.mapper';
import { RecordingsRepository, type ListCursor } from './recordings.repository';

/**
 * Recording upload workflow (API §2, FR-1.2, SEC-1): create a recording with consent and an
 * upload session, stream parts to storage, then complete. Completing creates a `created` run
 * (ADR-0025). Nothing here transcribes, analyses or researches audio.
 */
@Injectable()
export class RecordingsService {
  private readonly logger = new Logger(RecordingsService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RecordingsRepository) private readonly repo: RecordingsRepository,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(
    principal: Principal,
    workspaceId: string,
    input: CreateRecordingRequest,
  ): Promise<RecordingUploadResponse> {
    const { maxBytes, partSizeBytes, sessionTtlMinutes } = this.config.upload;
    if (input.sizeBytes > maxBytes) {
      throw new AppException(
        413,
        'PAYLOAD_TOO_LARGE',
        'Recording too large',
        `The maximum size is ${maxBytes} bytes.`,
      );
    }
    const id = randomUUID();
    const totalParts = Math.ceil(input.sizeBytes / partSizeBytes);
    const result = await this.repo.transaction(async (tx) => {
      const created = await this.repo.createRecording(tx, {
        id,
        workspaceId,
        originalFilename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        storageUri: this.storage.uriFor(StorageKeys.original(workspaceId, id)),
        attestedBy: principal.id,
        statementVersion: input.consent.statementVersion,
        partSize: partSizeBytes,
        totalParts,
        expiresAt: new Date(Date.now() + sessionTtlMinutes * 60_000),
      });
      await this.audit.record(
        {
          workspaceId,
          actorId: principal.id,
          action: 'recording.upload_started',
          resourceType: 'recording',
          resourceId: id,
          metadata: {
            sizeBytes: input.sizeBytes,
            totalParts,
            consentStatementVersion: input.consent.statementVersion,
          },
        },
        tx,
      );
      return created;
    });
    return {
      recording: toRecordingMetadata(result.recording, null),
      upload: toUploadSession(result.session),
    };
  }

  async list(workspaceId: string, limit: number, cursor?: string): Promise<RecordingList> {
    const rows = await this.repo.listRecordings(workspaceId, limit + 1, decodeCursor(cursor));
    const page = rows.slice(0, limit);
    const runs = await this.repo.latestRuns(
      workspaceId,
      page.map((r) => r.id),
    );
    const last = page.at(-1);
    return {
      items: page.map((r) => toRecordingMetadata(r, runs.get(r.id) ?? null)),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  async get(workspaceId: string, id: string): Promise<RecordingMetadata> {
    const rec = await this.requireRecording(workspaceId, id);
    const runs = await this.repo.latestRuns(workspaceId, [rec.id]);
    return toRecordingMetadata(rec, runs.get(rec.id) ?? null);
  }

  async getUploadSession(workspaceId: string, id: string): Promise<UploadSession> {
    await this.requireRecording(workspaceId, id);
    const session = await this.requireSession(workspaceId, id);
    return toUploadSession(await this.expireIfDue(session));
  }

  async uploadPart(
    workspaceId: string,
    id: string,
    partNumber: number,
    body: Readable,
    declaredLength: number | undefined,
  ): Promise<UploadPartResponse> {
    const rec = await this.requireRecording(workspaceId, id);
    if (rec.status !== 'uploading') {
      throw new AppException(409, 'INVALID_STATE_TRANSITION', 'Upload already finished');
    }
    const session = this.requireActive(
      await this.expireIfDue(await this.requireSession(workspaceId, id)),
    );
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > session.totalParts) {
      throw new AppException(
        422,
        'UPLOAD_PART_INVALID',
        'Invalid part number',
        `Parts are numbered 1 to ${session.totalParts}.`,
      );
    }
    const expected = expectedPartSize(
      rec.sizeBytes,
      session.partSize,
      session.totalParts,
      partNumber,
    );
    if (declaredLength !== undefined && declaredLength !== expected) {
      throw new AppException(
        422,
        'UPLOAD_PART_INVALID',
        'Unexpected part size',
        `Part ${partNumber} must be ${expected} bytes.`,
      );
    }

    const key = StorageKeys.uploadPart(rec.id, partNumber);
    let stored;
    try {
      stored = await this.storage.writeObject(key, body, { maxBytes: expected });
    } catch (error) {
      if (error instanceof ObjectTooLargeError) {
        throw new AppException(
          422,
          'UPLOAD_PART_INVALID',
          'Unexpected part size',
          `Part ${partNumber} must be ${expected} bytes.`,
        );
      }
      throw error;
    }
    if (stored.sizeBytes !== expected) {
      await this.storage.deleteObjects([key]);
      throw new AppException(
        422,
        'UPLOAD_PART_INVALID',
        'Unexpected part size',
        `Part ${partNumber} must be ${expected} bytes.`,
      );
    }
    await this.repo.markPartReceived(session.id, partNumber, stored.sizeBytes);
    return { partNumber, sizeBytes: stored.sizeBytes };
  }

  async complete(
    principal: Principal,
    workspaceId: string,
    id: string,
  ): Promise<RecordingMetadata> {
    const rec = await this.requireRecording(workspaceId, id);
    if (rec.status === 'uploaded') return this.get(workspaceId, id); // idempotent
    if (rec.status !== 'uploading') {
      throw new AppException(409, 'INVALID_STATE_TRANSITION', 'Upload cannot be completed');
    }
    const session = this.requireActive(
      await this.expireIfDue(await this.requireSession(workspaceId, id)),
    );
    const missing = missingParts(session);
    if (missing.length > 0) {
      throw new AppException(
        409,
        'UPLOAD_INCOMPLETE',
        'Upload incomplete',
        `${missing.length} part(s) not yet received.`,
      );
    }

    const partKeys = Array.from({ length: session.totalParts }, (_, i) =>
      StorageKeys.uploadPart(rec.id, i + 1),
    );
    const originalKey = StorageKeys.original(workspaceId, rec.id);
    const composed = await this.storage.composeObject(partKeys, originalKey);
    if (composed.sizeBytes !== rec.sizeBytes) {
      await this.storage.deleteObjects([originalKey]);
      throw new AppException(
        409,
        'UPLOAD_INCOMPLETE',
        'Upload incomplete',
        'Received size does not match the declared size.',
      );
    }

    const head = await this.storage.readHead(originalKey, SIGNATURE_BYTES);
    if (!signatureMatches(rec.mimeType, head)) {
      await this.repo.transaction(async (tx) => {
        await this.repo.markInvalid(tx, rec.id, 'MEDIA_SIGNATURE_MISMATCH');
        await this.repo.setSessionStatus(session.id, 'aborted', tx);
        await this.audit.record(
          {
            workspaceId,
            actorId: principal.id,
            action: 'recording.upload_rejected',
            resourceType: 'recording',
            resourceId: rec.id,
            metadata: { code: 'MEDIA_SIGNATURE_MISMATCH' },
          },
          tx,
        );
      });
      await this.cleanup([originalKey, ...partKeys]);
      throw new AppException(
        422,
        'MEDIA_SIGNATURE_MISMATCH',
        'File does not match its declared type',
        'The file content does not match the declared audio format.',
      );
    }

    await this.repo.transaction(async (tx) => {
      const locked = await this.repo.lockRecording(tx, workspaceId, rec.id);
      if (!locked || locked.status !== 'uploading') return; // a concurrent completion won
      await this.repo.markUploaded(tx, rec.id, composed.sha256);
      await this.repo.setSessionStatus(session.id, 'completed', tx);
      const run = await this.repo.createRun(tx, workspaceId, rec.id);
      await this.audit.record(
        {
          workspaceId,
          actorId: principal.id,
          action: 'recording.upload_completed',
          resourceType: 'recording',
          resourceId: rec.id,
          metadata: { sizeBytes: composed.sizeBytes, runId: run.id },
        },
        tx,
      );
    });
    await this.cleanup(partKeys);
    return this.get(workspaceId, id);
  }

  private async requireRecording(workspaceId: string, id: string): Promise<Recording> {
    const rec = await this.repo.findRecording(workspaceId, id);
    if (!rec) throw AppException.notFound('Recording');
    return rec;
  }

  private async requireSession(
    workspaceId: string,
    recordingId: string,
  ): Promise<UploadSessionRow> {
    const session = await this.repo.findActiveSession(recordingId, workspaceId);
    if (!session) throw AppException.notFound('Upload session');
    return session;
  }

  private async expireIfDue(session: UploadSessionRow): Promise<UploadSessionRow> {
    if (session.status === 'active' && session.expiresAt.getTime() <= Date.now()) {
      await this.repo.setSessionStatus(session.id, 'expired');
      return { ...session, status: 'expired' };
    }
    return session;
  }

  private requireActive(session: UploadSessionRow): UploadSessionRow {
    if (session.status === 'expired')
      throw new AppException(409, 'UPLOAD_EXPIRED', 'Upload session expired');
    if (session.status !== 'active')
      throw new AppException(409, 'INVALID_STATE_TRANSITION', 'Upload session is not active');
    return session;
  }

  /** Best effort: leftover parts are harmless and are reported by count only. */
  private async cleanup(keys: string[]): Promise<void> {
    try {
      await this.storage.deleteObjects(keys);
    } catch {
      this.logger.warn({ msg: 'storage_cleanup_failed', objects: keys.length });
    }
  }
}

export function expectedPartSize(
  totalBytes: number,
  partSize: number,
  totalParts: number,
  partNumber: number,
): number {
  return partNumber < totalParts ? partSize : totalBytes - partSize * (totalParts - 1);
}

function missingParts(session: UploadSessionRow): number[] {
  const missing: number[] = [];
  for (let n = 1; n <= session.totalParts; n++) {
    if (!session.partsReceived[String(n)]) missing.push(n);
  }
  return missing;
}

function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt.toISOString(), cursor.id])).toString(
    'base64url',
  );
}

function decodeCursor(raw: string | undefined): ListCursor | undefined {
  if (!raw) return undefined;
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as [
      string,
      string,
    ];
    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime()) || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('bad cursor');
    return { createdAt: date, id };
  } catch {
    throw new AppException(422, 'VALIDATION_FAILED', 'Invalid cursor');
  }
}
