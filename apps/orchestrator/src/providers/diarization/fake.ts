import {
  FAKE_PROVIDER_ID,
  type DiarizationProvider,
  type DiarizationRequest,
  type DiarizationTurn,
} from '@vip/contracts';
import { z } from 'zod';
import { ProviderError } from '../errors';
import type { RawStore } from '../raw-store';

export const FAKE_TURN_MS = 10_000;
/** Every third turn runs this long into the next one, so overlapping speech is exercised. */
export const FAKE_OVERLAP_MS = 500;

const FakePayload = z.object({
  schema: z.literal('fake-diarization-v1'),
  fake: z.literal(true),
  durationMs: z.number().int().min(0),
  turns: z.array(
    z.object({
      startMs: z.number().int().min(0),
      endMs: z.number().int().min(0),
      speakerKey: z.string().min(1).max(64),
    }),
  ),
});

/**
 * Deterministic development adapter (ADR-0012, D-2C-03): two speakers alternate on a fixed 10 s
 * grid, with a 0.5 s overlap into the next turn at every third boundary. Whole-file only; the
 * `window` request parameter is the ADR-0016 hook and is not used here. No confidence.
 */
export class FakeDiarizationProvider implements DiarizationProvider {
  readonly id = FAKE_PROVIDER_ID;
  readonly model = 'fake-diarization-1';

  constructor(private readonly store: RawStore) {}

  capabilities() {
    return { windowed: false, fake: true };
  }

  async diarize(req: DiarizationRequest) {
    const turns: DiarizationTurn[] = [];
    for (let k = 0; k * FAKE_TURN_MS < req.durationMs; k += 1) {
      const start = k * FAKE_TURN_MS;
      let end = Math.min(start + FAKE_TURN_MS, req.durationMs);
      if (k % 3 === 2 && end < req.durationMs)
        end = Math.min(end + FAKE_OVERLAP_MS, req.durationMs);
      turns.push({
        startMs: start,
        endMs: end,
        speakerKey: k % 2 === 0 ? 'SPEAKER_00' : 'SPEAKER_01',
      });
    }
    const payload = {
      schema: 'fake-diarization-v1',
      fake: true,
      durationMs: req.durationMs,
      turns,
    };
    const stored = await this.store.put(req.rawKey, payload);
    return {
      raw: { payloadUri: stored.uri, sha256: stored.sha256, providerModel: this.model },
      turns: this.mapRaw(payload, req),
    };
  }

  mapRaw(payload: unknown, _req: DiarizationRequest): DiarizationTurn[] {
    const parsed = FakePayload.safeParse(payload);
    if (!parsed.success) throw new ProviderError('RAW_OUTPUT_INVALID', false);
    return parsed.data.turns;
  }
}
