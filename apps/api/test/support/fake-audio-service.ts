import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Throwaway, test-only value (not a credential). */
export const FAKE_AUDIO_TOKEN = 'test-only-audio-token-0000000000000000';

export const FAKE_CAPABILITIES = {
  contractVersion: '2',
  serviceVersion: '0.1.0',
  python: '3.12.8',
  ffmpeg: { version: '7.1.2' },
  numpy: '2.5.5',
  vad: 'none',
  landlock: { supported: true, abi: 4, enforced: true },
  taskTypes: ['probe', 'preprocess'],
};

/**
 * In-process stand-in for the audio service (contract v2): the API only needs readiness, the
 * handshake and capabilities. Tasks are served by the orchestrator, so they are not faked here.
 * It enforces the bearer token like the real service.
 */
export class FakeAudioService {
  private server?: Server;
  /** When true every authorised request answers 503 (service down). */
  down = false;
  capabilities: Record<string, unknown> = FAKE_CAPABILITIES;
  readonly requests: string[] = [];

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const json = (status: number, payload: unknown) =>
          res
            .writeHead(status, { 'content-type': 'application/json' })
            .end(JSON.stringify(payload));
        this.requests.push(`${req.method} ${req.url}`);
        if (
          req.url !== '/health/live' &&
          req.headers.authorization !== `Bearer ${FAKE_AUDIO_TOKEN}`
        )
          return json(401, {
            type: 'about:blank',
            title: 'Unauthorized',
            status: 401,
            code: 'UNAUTHORIZED',
          });
        if (this.down)
          return json(503, {
            type: 'about:blank',
            title: 'down',
            status: 503,
            code: 'INTERNAL_ERROR',
          });
        if (req.url === '/health/ready')
          return json(200, { status: 'ok', service: 'audio-service', version: '0.1.0' });
        if (req.url === '/v1/capabilities') return json(200, this.capabilities);
        if (req.url === '/v1/handshake') {
          const { requestId } = JSON.parse(body) as { requestId: string };
          return json(200, {
            contractVersion: '2',
            serviceVersion: '0.1.0',
            requestId,
            accepted: true,
          });
        }
        return json(404, {
          type: 'about:blank',
          title: 'Not found',
          status: 404,
          code: 'NOT_FOUND',
        });
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise((r) => this.server?.close(r));
  }
}
