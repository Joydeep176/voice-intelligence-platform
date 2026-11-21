import { Readable } from 'node:stream';
import type { AuditService } from '../audit/audit.service';
import type { AppConfig } from '../config/app-config';
import type { StorageService } from '../storage/storage.service';
import { RecordingsService, expectedPartSize } from './recordings.service';
import type { RecordingsRepository } from './recordings.repository';

describe('expectedPartSize', () => {
  it('uses the part size for all but the last part', () => {
    expect(expectedPartSize(25, 10, 3, 1)).toBe(10);
    expect(expectedPartSize(25, 10, 3, 2)).toBe(10);
    expect(expectedPartSize(25, 10, 3, 3)).toBe(5);
  });

  it('handles an exact multiple and a single part', () => {
    expect(expectedPartSize(20, 10, 2, 2)).toBe(10);
    expect(expectedPartSize(7, 10, 1, 1)).toBe(7);
  });
});

const STORAGE_CALLS = new Set(['compose', 'readHead', 'delete', 'write', 'move']);

describe('RecordingsService concurrency (lock ordering)', () => {
  const WS = '00000000-0000-4000-8000-000000000001';
  const ID = '6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b10';
  const principal = { id: 'dev-local' } as never;
  const now = new Date('2026-11-21T00:00:00Z');
  const wavHead = Buffer.from('RIFF\0\0\0\0WAVEfmt ');
  const recording = (status: string) => ({
    id: ID,
    workspaceId: WS,
    originalFilename: 'a.wav',
    mimeType: 'audio/wav',
    sizeBytes: 20,
    durationMs: null,
    sha256: null,
    status,
    createdAt: now,
    updatedAt: now,
  });
  const session = {
    id: 'sess',
    status: 'active',
    partSize: 10,
    totalParts: 2,
    partsReceived: { '1': { sizeBytes: 10 }, '2': { sizeBytes: 10 } },
    expiresAt: new Date(Date.now() + 3_600_000),
  };

  let calls: string[];
  let violations: string[];
  let inLock: boolean;
  let sessionState: Record<string, unknown>;
  let current: string;
  let repo: Record<string, jest.Mock>;
  let storage: Record<string, jest.Mock>;
  let service: RecordingsService;
  const tx = { tx: true };

  beforeEach(() => {
    calls = [];
    violations = [];
    inLock = false;
    sessionState = { ...session };
    current = 'uploading';
    const track =
      (name: string, value?: () => unknown) =>
      (...args: unknown[]) => {
        calls.push(name);
        // Inside the locked transaction every repo call must use the transaction connection.
        if (inLock && !STORAGE_CALLS.has(name) && name !== 'lock' && !args.includes(tx)) {
          violations.push(name);
        }
        return Promise.resolve(value?.());
      };
    repo = {
      transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => {
        inLock = true;
        try {
          return await fn(tx);
        } finally {
          inLock = false;
        }
      }),
      lockRecording: jest.fn(track('lock', () => recording(current))),
      findRecording: jest.fn(track('findRecording', () => recording(current))),
      findActiveSession: jest.fn(track('session', () => sessionState)),
      latestRuns: jest.fn(async () => new Map()),
      markUploaded: jest.fn(
        track('markUploaded', () => {
          current = 'uploaded';
        }),
      ),
      markInvalid: jest.fn(track('markInvalid')),
      setSessionStatus: jest.fn(track('setSessionStatus')),
      createRun: jest.fn(track('createRun', () => ({ id: 'run' }))),
      markPartReceived: jest.fn(track('markPartReceived')),
    };
    repo.setSessionStatus!.mockImplementation(track('setSessionStatus'));
    storage = {
      composeObject: jest.fn(track('compose', () => ({ sizeBytes: 20, sha256: 'a'.repeat(64) }))),
      readHead: jest.fn(track('readHead', () => wavHead)),
      deleteObjects: jest.fn(track('delete')),
      moveObject: jest.fn(track('move')),
      writeObject: jest.fn(track('write', () => ({ sizeBytes: 10, sha256: 'b'.repeat(64) }))),
    };
    const audit = { record: jest.fn(track('audit')) };
    service = new RecordingsService(
      {} as AppConfig,
      repo as unknown as RecordingsRepository,
      storage as unknown as StorageService,
      audit as unknown as AuditService,
    );
  });

  it('takes the recording lock before composing and commits everything under it', async () => {
    await service.complete(principal, WS, ID);
    expect(calls.slice(0, 3)).toEqual(['lock', 'session', 'compose']);
    expect(calls.indexOf('lock')).toBeLessThan(calls.indexOf('compose'));
    expect(calls).toEqual(
      expect.arrayContaining(['markUploaded', 'setSessionStatus', 'createRun', 'audit']),
    );
    expect(repo.transaction).toHaveBeenCalledTimes(1);
    // Parts are removed only after the transaction.
    expect(calls.indexOf('delete')).toBeGreaterThan(calls.indexOf('audit'));
  });

  it('is idempotent: a second complete after success does not recompose', async () => {
    await service.complete(principal, WS, ID);
    (storage.composeObject as jest.Mock).mockClear();
    repo.createRun!.mockClear();
    const again = await service.complete(principal, WS, ID);
    expect(again.status).toBe('uploaded');
    expect(storage.composeObject).not.toHaveBeenCalled();
    expect(repo.createRun).not.toHaveBeenCalled();
  });

  it('records a signature mismatch inside the locked transaction', async () => {
    storage.readHead!.mockResolvedValue(Buffer.alloc(16, 0x41));
    await expect(service.complete(principal, WS, ID)).rejects.toMatchObject({
      code: 'MEDIA_SIGNATURE_MISMATCH',
    });
    expect(calls.indexOf('lock')).toBeLessThan(calls.indexOf('markInvalid'));
    expect(repo.markUploaded).not.toHaveBeenCalled();
    expect(repo.createRun).not.toHaveBeenCalled();
  });

  it('deletes the composed original if the transaction fails after composing', async () => {
    repo.createRun!.mockImplementation(async () => {
      current = 'uploading'; // the failed transaction rolls markUploaded back
      throw new Error('db down');
    });
    await expect(service.complete(principal, WS, ID)).rejects.toThrow('db down');
    expect(storage.deleteObjects).toHaveBeenCalledWith([`recordings/${WS}/${ID}/original`]);
  });

  it('does not touch storage when completion is refused before composing', async () => {
    current = 'invalid';
    await expect(service.complete(principal, WS, ID)).rejects.toMatchObject({ status: 409 });
    expect(storage.composeObject).not.toHaveBeenCalled();
    expect(storage.deleteObjects).not.toHaveBeenCalled();
  });

  it('streams the part body before taking the lock, then promotes it under the lock', async () => {
    await service.uploadPart(WS, ID, 1, Readable.from([]), 10);
    expect(calls.indexOf('write')).toBeLessThan(calls.indexOf('lock'));
    expect(calls.indexOf('lock')).toBeLessThan(calls.indexOf('markPartReceived'));
    expect(calls.indexOf('markPartReceived')).toBeLessThan(calls.indexOf('move'));
    expect(repo.markPartReceived).toHaveBeenCalledWith(tx, 'sess', 1, 10);
    expect(violations).toEqual([]);
    const [stagedKey] = storage.writeObject!.mock.calls[0] as [string];
    expect(stagedKey).toMatch(new RegExp(`^uploads/${ID}/staging/[0-9a-f-]{36}$`));
    expect(storage.moveObject).toHaveBeenCalledWith(stagedKey, `uploads/${ID}/parts/000001`);
  });

  it('deletes the staged part and refuses it when the recording left uploading', async () => {
    (repo.lockRecording as jest.Mock).mockImplementationOnce(async () => {
      inLock = true;
      return recording('uploaded');
    });
    await expect(service.uploadPart(WS, ID, 1, Readable.from([]), 10)).rejects.toMatchObject({
      status: 409,
    });
    expect(storage.moveObject).not.toHaveBeenCalled();
    const [stagedKey] = storage.writeObject!.mock.calls[0] as [string];
    expect(storage.deleteObjects).toHaveBeenCalledWith([stagedKey]);
  });

  it('refuses parts for a finished recording before reading the body', async () => {
    current = 'uploaded';
    await expect(service.uploadPart(WS, ID, 1, Readable.from([]), 10)).rejects.toMatchObject({
      status: 409,
    });
    expect(storage.writeObject).not.toHaveBeenCalled();
  });

  describe('session expiry inside the locked path (no second connection)', () => {
    beforeEach(() => {
      sessionState = { ...session, expiresAt: new Date(Date.now() - 1000) };
    });

    it('complete persists expiry only after the transaction ends', async () => {
      await expect(service.complete(principal, WS, ID)).rejects.toMatchObject({
        code: 'UPLOAD_EXPIRED',
      });
      expect(violations).toEqual([]);
      expect(repo.setSessionStatus).toHaveBeenCalledWith('sess', 'expired');
      expect(storage.composeObject).not.toHaveBeenCalled();
      expect(repo.transaction).toHaveBeenCalledTimes(1);
    });

    it('uploadPart persists expiry only after the transaction ends and deletes the staged part', async () => {
      // Session looks active for the unlocked pre-check, expired once the lock is held.
      repo.findActiveSession!.mockImplementationOnce(async () => ({ ...session }));
      await expect(service.uploadPart(WS, ID, 1, Readable.from([]), 10)).rejects.toMatchObject({
        code: 'UPLOAD_EXPIRED',
      });
      expect(violations).toEqual([]);
      expect(repo.setSessionStatus).toHaveBeenCalledWith('sess', 'expired');
      expect(storage.moveObject).not.toHaveBeenCalled();
      expect(storage.deleteObjects).toHaveBeenCalledTimes(1);
    });
  });

  describe('discarding the composed original after a failed completion (R2F-01)', () => {
    const failCreateRun = () => repo.createRun!.mockRejectedValue(new Error('db down'));
    it.each([
      ['same sha', 'a'.repeat(64)],
      ['different sha', 'c'.repeat(64)],
    ])('keeps the original when the locked re-read shows uploaded (%s)', async (_n, sha) => {
      let locks = 0;
      (repo.lockRecording as jest.Mock).mockImplementation(async () => {
        calls.push('lock');
        return locks++ === 0 ? recording('uploading') : { ...recording('uploaded'), sha256: sha };
      });
      failCreateRun();
      await expect(service.complete(principal, WS, ID)).rejects.toThrow('db down');
      expect(locks).toBe(2); // the discard decision takes the lock
      expect(storage.deleteObjects).not.toHaveBeenCalled();
    });

    it.each(['uploading', 'invalid'])(
      'deletes the original under the lock when the status is %s',
      async (status) => {
        let locks = 0;
        (repo.lockRecording as jest.Mock).mockImplementation(async () => {
          calls.push('lock');
          return locks++ === 0 ? recording('uploading') : recording(status);
        });
        failCreateRun();
        await expect(service.complete(principal, WS, ID)).rejects.toThrow('db down');
        expect(storage.deleteObjects).toHaveBeenCalledWith([`recordings/${WS}/${ID}/original`]);
        expect(violations).toEqual([]);
      },
    );

    it('keeps the original, logging by ID only, when the decision transaction fails', async () => {
      let locks = 0;
      (repo.lockRecording as jest.Mock).mockImplementation(async () => {
        if (locks++ > 0) throw new Error('db down');
        calls.push('lock');
        return recording('uploading');
      });
      failCreateRun();
      await expect(service.complete(principal, WS, ID)).rejects.toThrow('db down');
      expect(storage.deleteObjects).not.toHaveBeenCalled();
    });
  });

  it('records the part before promoting it, so a failed move rolls back (R2F-03)', async () => {
    await service.uploadPart(WS, ID, 1, Readable.from([]), 10);
    expect(calls.indexOf('markPartReceived')).toBeLessThan(calls.indexOf('move'));
    storage.moveObject!.mockRejectedValueOnce(new Error('rename failed'));
    storage.deleteObjects!.mockClear();
    await expect(service.uploadPart(WS, ID, 1, Readable.from([]), 10)).rejects.toThrow(
      'rename failed',
    );
    const [stagedKey] = storage.writeObject!.mock.calls[1] as [string];
    expect(storage.deleteObjects).toHaveBeenCalledWith([stagedKey]);
  });

  it('still answers 409 UPLOAD_EXPIRED when persisting the expiry fails (R2F-05)', async () => {
    sessionState = { ...session, expiresAt: new Date(Date.now() - 1000) };
    repo.setSessionStatus!.mockRejectedValue(Object.assign(new Error('pool'), { code: 'X1' }));
    await expect(service.complete(principal, WS, ID)).rejects.toMatchObject({
      status: 409,
      code: 'UPLOAD_EXPIRED',
    });
  });
});
