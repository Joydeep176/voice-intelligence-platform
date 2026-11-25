import {
  FAKE_PROVIDER_ID,
  type SpeechToTextProvider,
  type SttRequest,
  type SttSegment,
} from '@vip/contracts';
import { z } from 'zod';
import { formatClock } from '../clock';
import { ProviderError } from '../errors';
import type { RawStore } from '../raw-store';

/** Grid of the fake's segments on the absolute timeline (independent of the window layout). */
export const FAKE_STT_CELL_MS = 10_000;

const FakePayload = z.object({
  schema: z.literal('fake-stt-v1'),
  fake: z.literal(true),
  windowIndex: z.number().int().min(0),
  cells: z.array(z.object({ startMs: z.number().int().min(0), endMs: z.number().int().min(0) })),
});

/**
 * Deterministic development adapter (ADR-0012, D-2C-03). Its output is derived only from the
 * window index and times, carries no confidence (never fabricated) and is not a transcription:
 * text is a visible placeholder and the capabilities say `fake: true`.
 *
 * Segments sit on a fixed 10 s absolute grid (clipped to the recording). A window returns the
 * cells whose midpoint falls inside it, so neighbouring windows may both return a cell near the
 * overlap and the coordinator's stitching decides which one is kept.
 */
export class FakeSttProvider implements SpeechToTextProvider {
  readonly id = FAKE_PROVIDER_ID;
  readonly model = 'fake-stt-1';

  constructor(private readonly store: RawStore) {}

  capabilities() {
    return {
      languages: ['en' as const],
      codeSwitching: false,
      wordTimestamps: false,
      diarization: false,
      fake: true,
    };
  }

  async transcribe(req: SttRequest) {
    const cells: { startMs: number; endMs: number }[] = [];
    const first = Math.floor(req.window.startMs / FAKE_STT_CELL_MS) * FAKE_STT_CELL_MS;
    for (let start = first; start < req.window.endMs; start += FAKE_STT_CELL_MS) {
      const end = Math.min(start + FAKE_STT_CELL_MS, req.audioDurationMs);
      if (end <= start) break;
      const mid = (start + end) / 2;
      if (mid >= req.window.startMs && mid < req.window.endMs)
        cells.push({ startMs: start, endMs: end });
    }
    const payload = { schema: 'fake-stt-v1', fake: true, windowIndex: req.window.index, cells };
    const stored = await this.store.put(req.rawKey, payload);
    return {
      raw: { payloadUri: stored.uri, sha256: stored.sha256, providerModel: this.model },
      segments: this.mapRaw(payload, req),
    };
  }

  mapRaw(payload: unknown, req: SttRequest): SttSegment[] {
    const parsed = FakePayload.safeParse(payload);
    if (!parsed.success) throw new ProviderError('RAW_OUTPUT_INVALID', false);
    return parsed.data.cells.map((c) => ({
      startMs: c.startMs,
      endMs: c.endMs,
      text: `[fake transcript] window ${String(req.window.index)} (${formatClock(c.startMs)}–${formatClock(c.endMs)})`,
      language: 'en' as const,
    }));
  }
}
