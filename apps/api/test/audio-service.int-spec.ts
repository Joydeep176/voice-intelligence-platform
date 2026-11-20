import {
  AudioServiceClient,
  AudioServiceUnavailableError,
} from '../src/audio-service/audio-service.client';
import { loadConfig } from '../src/config/app-config';

/**
 * Node → Python prototype (ADR-0002): requires the audio service to be running at
 * AUDIO_SERVICE_URL (see docs/development/SETUP.md).
 */
const config = (url: string) =>
  loadConfig({
    AUTH_MODE: 'dev',
    DEV_WORKSPACE_ID: '00000000-0000-4000-8000-000000000001',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x',
    REDIS_URL: 'redis://127.0.0.1:1',
    AUDIO_SERVICE_URL: url,
    AUDIO_SERVICE_TIMEOUT_MS: '1500',
  });

describe('audio service client (integration)', () => {
  const url = process.env.AUDIO_SERVICE_URL ?? 'http://127.0.0.1:8001';

  it('passes readiness and the contract handshake against the running service', async () => {
    const client = new AudioServiceClient(config(url));
    await expect(client.ready()).resolves.toMatchObject({ status: 'ok', service: 'audio-service' });
    await expect(client.handshake()).resolves.toMatchObject({
      contractVersion: '1',
      accepted: true,
    });
  });

  it('reports a safe, content-free error when the service is unreachable', async () => {
    const client = new AudioServiceClient(config('http://127.0.0.1:9'));
    await expect(client.handshake()).rejects.toBeInstanceOf(AudioServiceUnavailableError);
    await expect(client.handshake()).rejects.toMatchObject({ reason: 'UNREACHABLE' });
  });
});
