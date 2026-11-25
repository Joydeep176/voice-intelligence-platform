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
import { AudioQueues } from '../queue/audio-queues.producer';
import { ObjectTooLargeError, StorageKeys, StorageService } from '../storage/storage.service';
import { SIGNATURE_BYTES, signatureMatches } from './media-signature';
import { toRecordingMetadata, toUploadSession } from './recording.mapper';
import { RecordingsRepository, type ListCursor, type Tx } from './recordings.repository';

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
    @Inject(AudioQueues) private readonly queues: AudioQueues,
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

  /**
   * The part body is streamed to a unique staging key with no lock or transaction, so slow
   * clients never hold a pooled connection. A short transaction then takes the recording row
   * lock, re-checks `uploading` and the session, promotes the staged part and records it, so a
   * part cannot land while a completion holds the lock or after the recording left `uploading`
   * (SEC-04, ADR-0007). Inside the lock only `tx` is used: a second pooled connection while
   * holding the lock could deadlock the pool. The staged object is always deleted on failure.
   */
  async uploadPart(
    workspaceId: string,
    id: string,
    partNumber: number,
    body: Readable,
    declaredLength: number | undefined,
  ): Promise<UploadPartResponse> {
    // Unlocked pre-checks: fail fast before reading the body. Re-checked under the lock below.
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

    const stagedKey = StorageKeys.stagedPart(rec.id, randomUUID());
    const finalKey = StorageKeys.uploadPart(rec.id, partNumber);
    try {
      let stored;
      try {
        stored = await this.storage.writeObject(stagedKey, body, { maxBytes: expected });
      } catch (error) {
        if (error instanceof ObjectTooLargeError) throw invalidPartSize(partNumber, expected);
        throw error;
      }
      if (stored.sizeBytes !== expected) throw invalidPartSize(partNumber, expected);

      const outcome = await this.repo.transaction(
        async (tx): Promise<{ kind: 'stored' } | { kind: 'expired'; sessionId: string }> => {
          const locked = await this.repo.lockRecording(tx, workspaceId, id);
          if (!locked) throw AppException.notFound('Recording');
          if (locked.status !== 'uploading') {
            throw new AppException(409, 'INVALID_STATE_TRANSITION', 'Upload already finished');
          }
          const current = await this.requireSession(workspaceId, id, tx);
          if (isExpired(current)) return { kind: 'expired', sessionId: current.id };
          this.requireActive(current);
          // Record first: a failed move then rolls the record back.
          await this.repo.markPartReceived(tx, current.id, partNumber, stored.sizeBytes);
          await this.storage.moveObject(stagedKey, finalKey);
          return { kind: 'stored' };
        },
      );
      if (outcome.kind === 'expired') {
        await this.persistExpiry(outcome.sessionId); // lock released
        throw expiredError();
      }
      return { partNumber, sizeBytes: stored.sizeBytes };
    } catch (error) {
      await this.cleanup([stagedKey]);
      throw error;
    }
  }

  /**
   * Completion runs entirely under the recording row lock (SEC-04 / ARCH-07, ADR-0007): the
   * status re-read, compose, size and signature checks, the sha256 write, the run and the audit
   * event are one transaction, so concurrent completes cannot compose twice, rename over a
   * committed original, or delete each other's parts. A second complete after success returns
   * the recording without recomposing. The lock is held during storage I/O: acceptable for
   * local storage in development; revisit with S3. Inside the lock only `tx` is used (no second
   * pooled connection); session expiry is persisted after the transaction. Part cleanup also
   * happens after commit.
   */
  async complete(
    principal: Principal,
    workspaceId: string,
    id: string,
  ): Promise<RecordingMetadata> {
    const originalKey = StorageKeys.original(workspaceId, id);
    let composeStarted = false;
    type Outcome =
      | { kind: 'already_uploaded' }
      | { kind: 'expired'; sessionId: string }
      | { kind: 'uploaded' | 'rejected'; keys: string[] };
    let outcome: Outcome;
    try {
      outcome = await this.repo.transaction(async (tx): Promise<Outcome> => {
        const rec = await this.repo.lockRecording(tx, workspaceId, id);
        if (!rec) throw AppException.notFound('Recording');
        if (rec.status === 'uploaded') return { kind: 'already_uploaded' }; // idempotent
        if (rec.status !== 'uploading') {
          throw new AppException(409, 'INVALID_STATE_TRANSITION', 'Upload cannot be completed');
        }
        const current = await this.requireSession(workspaceId, id, tx);
        if (isExpired(current)) return { kind: 'expired', sessionId: current.id };
        const session = this.requireActive(current);
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
        composeStarted = true;
        const composed = await this.storage.composeObject(partKeys, originalKey);
        if (composed.sizeBytes !== rec.sizeBytes) {
          throw new AppException(
            409,
            'UPLOAD_INCOMPLETE',
            'Upload incomplete',
            'Received size does not match the declared size.',
          );
        }

        const head = await this.storage.readHead(originalKey, SIGNATURE_BYTES);
        if (!signatureMatches(rec.mimeType, head)) {
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
          return { kind: 'rejected', keys: [originalKey, ...partKeys] };
        }

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
        return { kind: 'uploaded', keys: partKeys };
      });
    } catch (error) {
      if (composeStarted) await this.discardComposedOriginal(workspaceId, id, originalKey);
      throw error;
    }

    if (outcome.kind === 'expired') {
      await this.persistExpiry(outcome.sessionId); // lock released
      throw expiredError();
    }
    if (outcome.kind === 'rejected') {
      await this.cleanup(outcome.keys);
      throw new AppException(
        422,
        'MEDIA_SIGNATURE_MISMATCH',
        'File does not match its declared type',
        'The file content does not match the declared audio format.',
      );
    }
    if (outcome.kind === 'uploaded') {
      await this.cleanup(outcome.keys);
      await this.enqueueValidation(workspaceId, id);
    }
    return this.get(workspaceId, id);
  }

  /**
   * Validation (probe) runs automatically for NEW uploads only (LLD §4). It is queued after the
   * completion committed; a queue outage must not fail an upload that already succeeded, so it is
   * logged and the recording stays `uploaded` until processing is requested explicitly.
   */
  private async enqueueValidation(workspaceId: string, recordingId: string): Promise<void> {
    try {
      await this.queues.enqueueProbe(workspaceId, recordingId, false);
    } catch (error) {
      this.logger.warn({
        msg: 'validation_enqueue_failed',
        workspaceId,
        recordingId,
        errorName: (error as Error).name,
      });
    }
  }

  /**
   * After a failed completion, delete the composed original only if, under the recording row
   * lock, the recording is still `uploading` or `invalid`. An `uploaded` row (a concurrent
   * completion committed, or our COMMIT succeeded before the driver threw) always keeps its
   * object. The delete happens while the lock is held so no completion can interleave. If the
   * decision cannot be made, keep the object.
   */
  private async discardComposedOriginal(
    workspaceId: string,
    id: string,
    originalKey: string,
  ): Promise<void> {
    try {
      await this.repo.transaction(async (tx) => {
        const rec = await this.repo.lockRecording(tx, workspaceId, id);
        if (rec && (rec.status === 'uploading' || rec.status === 'invalid')) {
          await this.storage.deleteObjects([originalKey]);
        }
      });
    } catch {
      this.logger.warn({ msg: 'composed_original_kept', recordingId: id });
    }
  }

  /** Best effort, outside any lock: the caller always answers 409 UPLOAD_EXPIRED regardless. */
  private async persistExpiry(sessionId: string): Promise<void> {
    try {
      await this.repo.setSessionStatus(sessionId, 'expired');
    } catch (error) {
      this.logger.warn({
        msg: 'session_expire_persist_failed',
        sessionId,
        code: (error as { code?: string } | undefined)?.code ?? 'UNKNOWN',
      });
    }
  }

  private async requireRecording(workspaceId: string, id: string): Promise<Recording> {
    const rec = await this.repo.findRecording(workspaceId, id);
    if (!rec) throw AppException.notFound('Recording');
    return rec;
  }

  private async requireSession(
    workspaceId: string,
    recordingId: string,
    tx?: Tx,
  ): Promise<UploadSessionRow> {
    const session = await this.repo.findActiveSession(recordingId, workspaceId, tx);
    if (!session) throw AppException.notFound('Upload session');
    return session;
  }

  private async expireIfDue(session: UploadSessionRow): Promise<UploadSessionRow> {
    if (isExpired(session)) {
      await this.repo.setSessionStatus(session.id, 'expired');
      return { ...session, status: 'expired' };
    }
    return session;
  }

  private requireActive(session: UploadSessionRow): UploadSessionRow {
    if (session.status === 'expired') throw expiredError();
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

function isExpired(session: UploadSessionRow): boolean {
  return session.status === 'active' && session.expiresAt.getTime() <= Date.now();
}

function expiredError(): AppException {
  return new AppException(409, 'UPLOAD_EXPIRED', 'Upload session expired');
}

function invalidPartSize(partNumber: number, expected: number): AppException {
  return new AppException(
    422,
    'UPLOAD_PART_INVALID',
    'Unexpected part size',
    `Part ${partNumber} must be ${expected} bytes.`,
  );
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
