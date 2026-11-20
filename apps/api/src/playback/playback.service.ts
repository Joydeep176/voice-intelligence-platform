import { Inject, Injectable } from '@nestjs/common';
import { type PlaybackUrl, SUPPORTED_AUDIO_MIME_TYPES } from '@vip/contracts';
import type { Recording } from '@vip/db';
import { AuditService } from '../audit/audit.service';
import type { Principal } from '../auth/principal';
import { AppException } from '../common/app-exception';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { RecordingsRepository } from '../recordings/recordings.repository';
import { StorageKeys, StorageService } from '../storage/storage.service';
import { signPlaybackToken, verifyPlaybackToken } from './playback-token';

export const MEDIA_URL_PREFIX = '/api/v1/media/recordings/';
const PLAYABLE = new Set(['uploaded', 'valid']);
const AUDIO_TYPES = new Set<string>(SUPPORTED_AUDIO_MIME_TYPES);

export interface PlayableMedia {
  recording: Recording;
  key: string;
}

/** Playback URL issuance and per-request capability checks (ADR-0033). */
@Injectable()
export class PlaybackService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RecordingsRepository) private readonly repo: RecordingsRepository,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async issue(principal: Principal, workspaceId: string, id: string): Promise<PlaybackUrl> {
    const rec = await this.repo.findRecording(workspaceId, id);
    if (!rec) throw AppException.notFound('Recording');
    if (!PLAYABLE.has(rec.status)) {
      throw new AppException(
        409,
        'INVALID_STATE_TRANSITION',
        'Recording is not playable',
        'The recording has not finished uploading.',
      );
    }
    const exp = Math.floor(Date.now() / 1000) + this.config.playback.urlTtlSeconds;
    const token = signPlaybackToken(
      { v: 1, r: rec.id, w: rec.workspaceId, exp },
      this.config.playback.signingSecret,
    );
    const expiresAt = new Date(exp * 1000).toISOString();
    // Fail closed: if the audit write throws, no URL is returned.
    await this.audit.record({
      workspaceId,
      actorId: principal.id,
      action: 'recording.playback_url_issued',
      resourceType: 'recording',
      resourceId: rec.id,
      metadata: { expiresAt },
    });
    return { url: `${MEDIA_URL_PREFIX}${token}`, expiresAt };
  }

  /**
   * Resolves a token to a playable recording, re-checking ownership and integrity on every
   * request. Returns null for every failure so the caller can answer one uniform 404.
   * Integrity failures are logged by the caller via `integrityFailure`.
   */
  async resolve(
    token: string,
    onIntegrityFailure: (recordingId: string, code: string) => void,
  ): Promise<PlayableMedia | null> {
    const payload = verifyPlaybackToken(
      token,
      this.config.playback.signingSecret,
      Math.floor(Date.now() / 1000),
    );
    if (!payload) return null;
    const rec = await this.repo.findRecording(payload.w, payload.r);
    if (!rec || rec.workspaceId !== payload.w || !PLAYABLE.has(rec.status)) return null;
    const key = StorageKeys.original(rec.workspaceId, rec.id);
    if (this.storage.uriFor(key) !== rec.storageUri) {
      onIntegrityFailure(rec.id, 'STORAGE_URI_MISMATCH');
      return null;
    }
    if (!AUDIO_TYPES.has(rec.mimeType)) {
      onIntegrityFailure(rec.id, 'MIME_TYPE_INVALID');
      return null;
    }
    return { recording: rec, key };
  }
}
