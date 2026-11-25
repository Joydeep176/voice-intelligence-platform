import {
  AudioDiarizeConfig,
  AudioDiarizeResult,
  type DiarizationProvider,
  type DiarizationRequest,
  type DiarizationTurn,
} from '@vip/contracts';
import { z } from 'zod';
import type { DiarizationSettings } from '../../config';
import { runAudioTask, type AudioTaskDeps } from '../audio-task';
import { ProviderError } from '../errors';
import type { RawStore } from '../raw-store';

export const SHERPA_ONNX_PROVIDER_ID = 'sherpa-onnx';
export const SHERPA_ONNX_MODEL = 'pyannote-segmentation-3.0+3dspeaker-campplus-en-voxceleb-16k';

const RawPayload = z
  .object({
    schema: z.literal('audio-service-diarize-v1'),
    request: AudioDiarizeConfig,
    result: AudioDiarizeResult,
  })
  .strict();

/**
 * Self-hosted diarization (OD-03b, ADR-0037): sherpa-onnx with pyannote segmentation-3.0 and
 * 3D-Speaker CAM++ embeddings, run in the audio service (ADR-0002, HLD §5). Bounded memory per
 * ADR-0016: whole file up to `wholeFileMaxMs`, else overlapping windows with cross-window speaker
 * matching inside the service. One call covers the whole recording (`window` is not used).
 */
export class SherpaOnnxDiarizationProvider implements DiarizationProvider {
  readonly id = SHERPA_ONNX_PROVIDER_ID;
  readonly model = SHERPA_ONNX_MODEL;

  constructor(
    private readonly store: RawStore,
    private readonly deps: AudioTaskDeps,
    private readonly settings: DiarizationSettings,
  ) {}

  capabilities() {
    return { windowed: true, fake: false };
  }

  async diarize(req: DiarizationRequest) {
    const config: AudioDiarizeConfig = {
      schemaVersion: 1,
      engine: 'sherpa-onnx',
      audioDurationMs: req.durationMs,
      clusteringThreshold: this.settings.clusteringThreshold,
      minDurationOnMs: this.settings.minDurationOnMs,
      minDurationOffMs: this.settings.minDurationOffMs,
      wholeFileMaxMs: this.settings.wholeFileMaxMs,
      windowMs: this.settings.windowMs,
      overlapMs: this.settings.overlapMs,
      matchThreshold: this.settings.matchThreshold,
    };
    const result = await runAudioTask(this.deps, 'diarize', req.source, config);
    const payload = { schema: 'audio-service-diarize-v1', request: config, result };
    if (!RawPayload.safeParse(payload).success) {
      throw new ProviderError('PROVIDER_OUTPUT_INVALID', false);
    }
    const stored = await this.store.put(req.rawKey, payload); // verbatim, before mapping (ADR-0007)
    return {
      raw: { payloadUri: stored.uri, sha256: stored.sha256, providerModel: this.model },
      turns: this.mapRaw(payload, req),
    };
  }

  mapRaw(payload: unknown, req: DiarizationRequest): DiarizationTurn[] {
    const parsed = RawPayload.safeParse(payload);
    if (!parsed.success) throw new ProviderError('RAW_OUTPUT_INVALID', false);
    const { request, result } = parsed.data;
    if (
      request.audioDurationMs !== req.durationMs ||
      `${result.engine.segmentation.model}+${result.engine.embedding.model}` !== this.model
    ) {
      throw new ProviderError('RAW_OUTPUT_CONFLICT', false);
    }
    return result.turns.map((t) => ({
      startMs: t.startMs,
      endMs: t.endMs,
      speakerKey: t.speakerKey,
    }));
  }
}
