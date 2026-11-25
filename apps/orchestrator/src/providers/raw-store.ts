import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { storageUriForKey, type ProviderRawRef } from '@vip/contracts';
import { ProviderError } from './errors';

/** Keys are built from IDs and indexes only (backend rule): anything else is refused. */
const KEY = /^runs\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/(stt\/\d{1,6}|diarization\/whole)\.json$/;

export const sttRawKey = (workspaceId: string, runId: string, windowIndex: number): string =>
  `runs/${workspaceId}/${runId}/stt/${String(windowIndex)}.json`;
export const diarizationRawKey = (workspaceId: string, runId: string): string =>
  `runs/${workspaceId}/${runId}/diarization/whole.json`;

/**
 * A different payload is already stored under the key. Raw output is written once and never
 * replaced (ADR-0007): the stored object wins, and the caller must use it instead of its own.
 */
export class RawOutputExistsError extends Error {
  constructor(readonly key: string) {
    super('Raw output already stored under this key.');
    this.name = 'RawOutputExistsError';
  }
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';

/**
 * Where provider adapters put verbatim output before anything is parsed (ADR-0007).
 *
 * Write-once (Phase 2C audit §11.4): an object is created only if the key is free, from a fully
 * written and fsynced temp file, in one atomic step. A reader therefore never sees a partial
 * object, and a concurrent or repeated write can never replace a stored one. Writing identical
 * bytes again is a no-op; writing different bytes throws `RawOutputExistsError`. The database
 * row (which keeps the hash) is inserted only after the object exists, so a row never points at a
 * missing or partial object.
 */
export interface RawStore {
  put(key: string, payload: unknown): Promise<{ uri: string; sha256: string }>;
  /** Reads and hashes the stored bytes. Rejects when the object is missing. */
  get(key: string): Promise<{ payload: unknown; sha256: string }>;
  /** Like `get`, but resolves null when no object is stored under the key. */
  find(key: string): Promise<{ payload: unknown; sha256: string } | null>;
  uriFor(key: string): string;
}

export class LocalRawStore implements RawStore {
  constructor(private readonly root: string) {}

  uriFor(key: string): string {
    return storageUriForKey('local://x', key);
  }

  private path(key: string): string {
    if (!KEY.test(key)) throw new Error('Invalid raw output key.');
    return join(this.root, key);
  }

  async put(key: string, payload: unknown): Promise<{ uri: string; sha256: string }> {
    const target = this.path(key);
    const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
    const hash = sha256(bytes);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      // link() creates the target only if it does not exist (EEXIST otherwise): atomic, no overwrite.
      await link(temp, target);
      await syncDirectory(dirname(target)); // make the new entry durable before a row points at it
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readFile(target);
      if (sha256(existing) !== hash) throw new RawOutputExistsError(key);
    } finally {
      await rm(temp, { force: true });
    }
    return { uri: this.uriFor(key), sha256: hash };
  }

  /** An object that is not valid JSON is `ProviderError('RAW_OUTPUT_CORRUPT')` (not retryable). */
  async get(key: string): Promise<{ payload: unknown; sha256: string }> {
    const bytes = await readFile(this.path(key));
    let payload: unknown;
    try {
      payload = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new ProviderError('RAW_OUTPUT_CORRUPT', false);
    }
    return { payload, sha256: sha256(bytes) };
  }

  async find(key: string): Promise<{ payload: unknown; sha256: string } | null> {
    try {
      return await this.get(key);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }
}

/**
 * Raw output for a window or the whole file when no database row exists yet (audit §11.4). The
 * store is write-once, so: an object already stored under the key (an earlier attempt stopped
 * before inserting its row) is adopted instead of re-requesting the provider; and when a
 * concurrent attempt stores its object first, the provider call ends in `RawOutputExistsError`
 * and the stored object is used. Either way the row inserted next describes the stored bytes.
 */
export async function obtainRawOutput<T extends object>(
  store: RawStore,
  key: string,
  model: string,
  call: () => Promise<T & { raw: ProviderRawRef }>,
  map: (payload: unknown) => T,
): Promise<T & { raw: ProviderRawRef }> {
  const fromStore = (stored: { payload: unknown; sha256: string }) => ({
    ...map(stored.payload),
    raw: { payloadUri: store.uriFor(key), sha256: stored.sha256, providerModel: model },
  });
  const orphan = await store.find(key);
  if (orphan) return fromStore(orphan);
  let out: T & { raw: ProviderRawRef };
  try {
    out = await call();
  } catch (error) {
    if (!(error instanceof RawOutputExistsError)) throw error;
    return fromStore(await store.get(key));
  }
  // The row records the hash of the stored bytes, never just what the adapter reports.
  const stored = await store.find(key);
  if (!stored || stored.sha256 !== out.raw.sha256) {
    throw new ProviderError('RAW_OUTPUT_CORRUPT', false);
  }
  return out;
}
