import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { LocalStorageService } from './local-storage.service';
import { InvalidStorageKeyError, ObjectTooLargeError, StorageKeys } from './storage.service';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('LocalStorageService', () => {
  let root: string;
  let storage: LocalStorageService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vip-storage-'));
    storage = new LocalStorageService(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('streams an object to disk and reports size and sha256', async () => {
    const data = Buffer.from('synthetic bytes');
    const result = await storage.writeObject('a/b', Readable.from([data]), { maxBytes: 100 });
    expect(result).toEqual({ sizeBytes: data.length, sha256: sha(data) });
    expect(await readFile(join(root, 'a', 'b'))).toEqual(data);
  });

  it('rejects oversize streams and leaves no partial file behind', async () => {
    const chunks = [Buffer.alloc(60), Buffer.alloc(60)];
    await expect(
      storage.writeObject('a/big', Readable.from(chunks), { maxBytes: 100 }),
    ).rejects.toBeInstanceOf(ObjectTooLargeError);
    expect(existsSync(join(root, 'a', 'big'))).toBe(false);
    expect(readdirSync(join(root, 'a'))).toEqual([]);
  });

  it.each(['../escape', 'a/../../b', '/abs', 'A/upper', 'a//b', 'a/b/', 'name.wav', ''])(
    'rejects unsafe key %j',
    (key) => {
      expect(() => storage.uriFor(key)).toThrow(InvalidStorageKeyError);
    },
  );

  it('composes parts in order with a combined hash', async () => {
    const a = Buffer.from('first-');
    const b = Buffer.from('second');
    await storage.writeObject('p/1', Readable.from([a]), { maxBytes: 10 });
    await storage.writeObject('p/2', Readable.from([b]), { maxBytes: 10 });
    const result = await storage.composeObject(['p/1', 'p/2'], 'out/original');
    const both = Buffer.concat([a, b]);
    expect(result).toEqual({ sizeBytes: both.length, sha256: sha(both) });
    expect(await storage.readHead('out/original', 5)).toEqual(Buffer.from('first'));
  });

  it('deletes objects and ignores missing ones', async () => {
    await storage.writeObject('d/x', Readable.from([Buffer.from('x')]), { maxBytes: 1 });
    await storage.deleteObjects(['d/x', 'd/missing']);
    expect(existsSync(join(root, 'd', 'x'))).toBe(false);
  });

  it('builds keys only from IDs', () => {
    const id = '6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b10';
    expect(StorageKeys.uploadPart(id, 3)).toBe(`uploads/${id}/parts/000003`);
    expect(storage.uriFor(StorageKeys.original(id, id))).toBe(
      `local://recordings/${id}/${id}/original`,
    );
  });
});
