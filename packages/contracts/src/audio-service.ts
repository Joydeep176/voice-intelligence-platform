import { z } from 'zod';
import { Uuid } from './common.js';

/**
 * Audio-service internal API (LLD §3.1, ADR-0002, ADR-0023). Python mirrors these schemas
 * as Pydantic models in `services/audio/src/audio_service/contracts.py`; change both together.
 * Contract tests on both sides check the shared JSON fixtures in `packages/contracts/fixtures/audio-service`.
 */
export const AUDIO_SERVICE_CONTRACT_VERSION = '1';

export const AudioServiceProbe = z.object({
  status: z.enum(['ok', 'down']),
  service: z.literal('audio-service'),
  version: z.string(),
});
export type AudioServiceProbe = z.infer<typeof AudioServiceProbe>;

/** Phase 1 prototype: `POST /v1/handshake` verifies reachability and contract compatibility. */
export const HandshakeRequest = z.object({
  contractVersion: z.string().min(1).max(16),
  requestId: Uuid,
});
export type HandshakeRequest = z.infer<typeof HandshakeRequest>;

export const HandshakeResponse = z.object({
  contractVersion: z.string(),
  serviceVersion: z.string(),
  requestId: Uuid,
  accepted: z.literal(true),
});
export type HandshakeResponse = z.infer<typeof HandshakeResponse>;

/** Error body returned by the audio service (Problem Details subset). */
export const AudioServiceError = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
});
export type AudioServiceError = z.infer<typeof AudioServiceError>;
