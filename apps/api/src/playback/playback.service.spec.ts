import type { Recording } from '@vip/db';
import { AppException } from '../common/app-exception';
import { loadConfig } from '../config/app-config';
import { LocalStorageService } from '../storage/local-storage.service';
import { StorageKeys } from '../storage/storage.service';
import { signPlaybackToken } from './playback-token';
import { MEDIA_URL_PREFIX, PlaybackService } from './playback.service';

const SECRET = 'test-only-media-url-signing-secret-000000000000';
const W = '00000000-0000-4000-8000-000000000001';
const OTHER_W = '00000000-0000-4000-8000-0000000000aa';
const R = '6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b10';
const config = loadConfig({
  AUTH_MODE: 'dev',
  DEV_WORKSPACE_ID: W,
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x',
  REDIS_URL: 'redis://127.0.0.1:1',
  AUDIO_SERVICE_URL: 'http://127.0.0.1:1',
  MEDIA_URL_SIGNING_SECRET: SECRET,
});
const storage = new LocalStorageService('/nonexistent-test-root');
const principal = { id: 'dev-local', workspaceIds: [W], kind: 'development' as const };

function recording(patch: Partial<Recording> = {}): Recording {
  return {
    id: R,
    workspaceId: W,
    mimeType: 'audio/wav',
    status: 'uploaded',
    storageUri: storage.uriFor(StorageKeys.original(W, R)),
    ...patch,
  } as Recording;
}

describe('PlaybackService', () => {
  const repo = { findRecording: jest.fn() };
  const audit = { record: jest.fn() };
  const service = new PlaybackService(config, repo as never, storage, audit as never);
  const token = (over: Record<string, unknown> = {}) =>
    signPlaybackToken(
      { v: 1, r: R, w: W, exp: Math.floor(Date.now() / 1000) + 60, ...over },
      SECRET,
    );
  const noIntegrity = jest.fn();

  beforeEach(() => {
    jest.resetAllMocks();
    repo.findRecording.mockResolvedValue(recording());
    audit.record.mockResolvedValue(undefined);
  });

  describe('issue', () => {
    it('signs a workspace-scoped URL and audits it with IDs and expiry only', async () => {
      const result = await service.issue(principal, W, R);
      expect(repo.findRecording).toHaveBeenCalledWith(W, R);
      expect(result.url.startsWith(MEDIA_URL_PREFIX)).toBe(true);
      expect(audit.record).toHaveBeenCalledWith({
        workspaceId: W,
        actorId: 'dev-local',
        action: 'recording.playback_url_issued',
        resourceType: 'recording',
        resourceId: R,
        metadata: { expiresAt: result.expiresAt },
      });
      const media = await service.resolve(result.url.slice(MEDIA_URL_PREFIX.length), noIntegrity);
      expect(media?.recording.id).toBe(R);
    });

    it('404s for a missing or foreign recording', async () => {
      repo.findRecording.mockResolvedValue(null);
      await expect(service.issue(principal, W, R)).rejects.toMatchObject({ status: 404 });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it.each(['uploading', 'validating', 'invalid', 'deleting'])('409s for status %s', async (s) => {
      repo.findRecording.mockResolvedValue(recording({ status: s as Recording['status'] }));
      const error = await service.issue(principal, W, R).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppException);
      expect(error).toMatchObject({ status: 409, code: 'INVALID_STATE_TRANSITION' });
    });

    it('issues no URL when the audit write fails (fail closed)', async () => {
      audit.record.mockRejectedValue(new Error('db down'));
      await expect(service.issue(principal, W, R)).rejects.toThrow('db down');
    });
  });

  describe('resolve', () => {
    it('accepts uploaded and valid recordings', async () => {
      expect(await service.resolve(token(), noIntegrity)).toMatchObject({
        key: StorageKeys.original(W, R),
      });
      repo.findRecording.mockResolvedValue(recording({ status: 'valid' }));
      expect(await service.resolve(token(), noIntegrity)).not.toBeNull();
      expect(repo.findRecording).toHaveBeenLastCalledWith(W, R);
    });

    it('rejects bad, tampered and expired tokens without touching the database', async () => {
      expect(await service.resolve('garbage', noIntegrity)).toBeNull();
      expect(await service.resolve(token({ exp: 1 }), noIntegrity)).toBeNull();
      expect(repo.findRecording).not.toHaveBeenCalled();
    });

    it('re-checks the recording on every request', async () => {
      repo.findRecording.mockResolvedValue(null);
      expect(await service.resolve(token(), noIntegrity)).toBeNull();
      repo.findRecording.mockResolvedValue(recording({ workspaceId: OTHER_W }));
      expect(await service.resolve(token(), noIntegrity)).toBeNull();
      for (const status of ['uploading', 'invalid', 'deleting']) {
        repo.findRecording.mockResolvedValue(recording({ status: status as Recording['status'] }));
        expect(await service.resolve(token(), noIntegrity)).toBeNull();
      }
      expect(noIntegrity).not.toHaveBeenCalled();
    });

    it('reports integrity failures by code and returns null', async () => {
      repo.findRecording.mockResolvedValue(recording({ storageUri: 'local://elsewhere/x' }));
      expect(await service.resolve(token(), noIntegrity)).toBeNull();
      expect(noIntegrity).toHaveBeenCalledWith(R, 'STORAGE_URI_MISMATCH');
      repo.findRecording.mockResolvedValue(recording({ mimeType: 'text/html' }));
      expect(await service.resolve(token(), noIntegrity)).toBeNull();
      expect(noIntegrity).toHaveBeenCalledWith(R, 'MIME_TYPE_INVALID');
    });
  });
});
