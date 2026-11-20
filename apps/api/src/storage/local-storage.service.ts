import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { type Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  InvalidStorageKeyError,
  ObjectTooLargeError,
  StorageService,
  type StoredObject,
} from './storage.service';

const KEY_PATTERN = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/;

class MeasuringTransform extends Transform {
  readonly hash = createHash('sha256');
  bytes = 0;

  constructor(private readonly maxBytes = Number.POSITIVE_INFINITY) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      callback(new ObjectTooLargeError());
      return;
    }
    this.hash.update(chunk);
    callback(null, chunk);
  }
}

/**
 * Development storage on the local filesystem (DEPLOYMENT §1 `LocalStorage`). Writes stream
 * to a temporary file and are renamed into place, so readers never see partial objects and a
 * failed or oversized upload leaves nothing behind. Data is never buffered whole in memory.
 */
export class LocalStorageService extends StorageService {
  private readonly root: string;

  constructor(root: string) {
    super();
    this.root = resolve(root);
  }

  uriFor(key: string): string {
    this.pathFor(key);
    return `local://${key}`;
  }

  async writeObject(
    key: string,
    source: Readable,
    opts: { maxBytes: number },
  ): Promise<StoredObject> {
    const target = this.pathFor(key);
    const measure = new MeasuringTransform(opts.maxBytes);
    await this.writeAtomically(target, (out) => pipeline(source, measure, out));
    return { sizeBytes: measure.bytes, sha256: measure.hash.digest('hex') };
  }

  async composeObject(sourceKeys: readonly string[], destKey: string): Promise<StoredObject> {
    const target = this.pathFor(destKey);
    const sources = sourceKeys.map((k) => this.pathFor(k));
    const measure = new MeasuringTransform();
    await this.writeAtomically(target, async (out) => {
      const done = pipeline(measure, out);
      for (const src of sources) {
        await pipeline(createReadStream(src), measure, { end: false });
      }
      measure.end();
      await done;
    });
    return { sizeBytes: measure.bytes, sha256: measure.hash.digest('hex') };
  }

  async readHead(key: string, length: number): Promise<Buffer> {
    const handle = await open(this.pathFor(key), 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async deleteObjects(keys: readonly string[]): Promise<void> {
    await Promise.all(keys.map((k) => rm(this.pathFor(k), { force: true })));
  }

  /** Resolves a key inside the root. Rejects anything that could escape it. */
  private pathFor(key: string): string {
    if (!KEY_PATTERN.test(key)) throw new InvalidStorageKeyError();
    const full = resolve(this.root, ...key.split('/'));
    if (!full.startsWith(this.root + sep)) throw new InvalidStorageKeyError();
    return full;
  }

  private async writeAtomically(
    target: string,
    write: (out: NodeJS.WritableStream) => Promise<void>,
  ): Promise<void> {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${randomUUID()}.partial`;
    try {
      await write(createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }
}
