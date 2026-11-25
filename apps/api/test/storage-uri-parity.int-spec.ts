import { storageUriForKey } from '@vip/contracts';
import { tmpdir } from 'node:os';
import { LocalStorageService } from '../src/storage/local-storage.service';

/** The orchestrator builds derived-artifact URIs with the shared helper: it must equal `uriFor`. */
describe('storage URI parity (StorageService.uriFor vs storageUriForKey)', () => {
  it('matches the local driver for the same scheme', () => {
    const storage = new LocalStorageService(tmpdir());
    const reference = storage.uriFor('recordings/w/r/original');
    for (const key of ['derived/w/r/abc/canonical', 'derived/w/r/abc/manifest']) {
      expect(storageUriForKey(reference, key)).toBe(storage.uriFor(key));
    }
  });
});
