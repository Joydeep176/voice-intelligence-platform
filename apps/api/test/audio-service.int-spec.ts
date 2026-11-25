import {
  AudioServiceClient,
  AudioServiceUnavailableError,
} from '../src/audio-service/audio-service.client';
import { loadConfig } from '../src/config/app-config';
import { FAKE_AUDIO_TOKEN, FakeAudioService } from './support/fake-audio-service';

/**
 * Node → Python client against an in-process fake of contract v2 (bearer token, version "2").
 * The real container is exercised by the WS9 acceptance run, not here.
 */
const config = (url: string, token: string | null = FAKE_AUDIO_TOKEN) =>
  loadConfig({
    ...(token === null ? {} : { AUDIO_SERVICE_TOKEN: token }),
    AUTH_MODE: 'dev',
    DEV_WORKSPACE_ID: '00000000-0000-4000-8000-000000000001',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x',
    REDIS_URL: 'redis://127.0.0.1:1',
    AUDIO_SERVICE_URL: url,
    AUDIO_SERVICE_TIMEOUT_MS: '1500',
    MEDIA_URL_SIGNING_SECRET: 'test-only-media-url-signing-secret-000000000000',
  });

describe('audio service client (integration, contract v2)', () => {
  const fake = new FakeAudioService();
  let url: string;

  beforeAll(async () => {
    url = await fake.start();
  });
  afterAll(() => fake.stop());
  beforeEach(() => {
    fake.down = false;
    fake.requests.length = 0;
  });

  it('passes readiness, the contract handshake and capabilities', async () => {
    const client = new AudioServiceClient(config(url));
    await expect(client.ready()).resolves.toMatchObject({ status: 'ok', service: 'audio-service' });
    await expect(client.handshake()).resolves.toMatchObject({
      contractVersion: '2',
      accepted: true,
    });
    await expect(client.capabilities()).resolves.toMatchObject({ vad: 'none' });
  });

  it('reports NOT_CONFIGURED without a token and sends nothing', async () => {
    const client = new AudioServiceClient(config(url, null));
    await expect(client.handshake()).rejects.toMatchObject({ reason: 'NOT_CONFIGURED' });
    expect(fake.requests).toEqual([]);
  });

  it('maps a wrong token to UNAUTHORIZED', async () => {
    const client = new AudioServiceClient(config(url, 'x'.repeat(40)));
    await expect(client.ready()).rejects.toMatchObject({ reason: 'UNAUTHORIZED' });
  });

  it('reports a safe, content-free error when the service is unreachable', async () => {
    const client = new AudioServiceClient(config('http://127.0.0.1:9'));
    await expect(client.handshake()).rejects.toBeInstanceOf(AudioServiceUnavailableError);
    await expect(client.handshake()).rejects.toMatchObject({ reason: 'UNREACHABLE' });
  });
});
