import { ConfigError, loadConfig } from './app-config';

const base = {
  AUTH_MODE: 'dev',
  DEV_WORKSPACE_ID: '00000000-0000-4000-8000-000000000001',
  DATABASE_URL: 'postgres://u:secret-password@127.0.0.1:5432/vip',
  REDIS_URL: 'redis://127.0.0.1:6379',
  AUDIO_SERVICE_URL: 'http://127.0.0.1:8001/',
  MEDIA_URL_SIGNING_SECRET: 'test-only-media-url-signing-secret-000000000000',
};

describe('loadConfig', () => {
  it('applies defaults and normalises values', () => {
    const config = loadConfig(base);
    expect(config.env).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.audioService.url).toBe('http://127.0.0.1:8001');
    expect(config.storage.localRoot.endsWith('.local-storage')).toBe(true);
  });

  it('refuses development auth in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(ConfigError);
  });

  it('reports variable names only, never values', () => {
    try {
      loadConfig({ ...base, DATABASE_URL: 'not a url secret-password' });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain('DATABASE_URL');
      expect((error as Error).message).not.toContain('secret-password');
    }
  });

  describe('processing bounds', () => {
    it('has bounded interim defaults', () => {
      const config = loadConfig(base);
      expect(config.processing.maxRetries).toBe(3);
      expect(config.queues.audio).toEqual({ attempts: 5, backoffMs: 5000 });
    });

    it('rejects out-of-range values by name', () => {
      expect(() => loadConfig({ ...base, PROCESSING_MAX_RETRIES: '0' })).toThrow(
        /PROCESSING_MAX_RETRIES/,
      );
      expect(() => loadConfig({ ...base, QUEUE_AUDIO_ATTEMPTS: '99' })).toThrow(
        /QUEUE_AUDIO_ATTEMPTS/,
      );
    });
  });

  describe('audio service token (ADR-0035)', () => {
    it('is optional: unset and empty both mean "not configured"', () => {
      expect(loadConfig(base).audioService.token).toBeUndefined();
      expect(loadConfig({ ...base, AUDIO_SERVICE_TOKEN: '' }).audioService.token).toBeUndefined();
    });

    it('is accepted when at least 32 characters', () => {
      const token = 'a'.repeat(32);
      expect(loadConfig({ ...base, AUDIO_SERVICE_TOKEN: token }).audioService.token).toBe(token);
    });

    it('rejects a short token and names only the variable', () => {
      const short = 'short-secret-value';
      try {
        loadConfig({ ...base, AUDIO_SERVICE_TOKEN: short });
        throw new Error('expected failure');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as Error).message).toContain('AUDIO_SERVICE_TOKEN');
        expect((error as Error).message).not.toContain(short);
      }
    });
  });

  describe('playback signing', () => {
    it('is required, at least 32 characters and not the placeholder', () => {
      const { MEDIA_URL_SIGNING_SECRET: _omit, ...without } = base;
      expect(() => loadConfig(without)).toThrow(ConfigError);
      expect(() => loadConfig({ ...base, MEDIA_URL_SIGNING_SECRET: 'x'.repeat(31) })).toThrow(
        ConfigError,
      );
      try {
        loadConfig({ ...base, MEDIA_URL_SIGNING_SECRET: `change-me-${'x'.repeat(40)}` });
        throw new Error('expected failure');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as Error).message).toContain('MEDIA_URL_SIGNING_SECRET');
        expect((error as Error).message).not.toContain('change-me');
      }
    });

    it('defaults the TTL to 300 seconds and bounds it to 30-3600', () => {
      expect(loadConfig(base).playback.urlTtlSeconds).toBe(300);
      expect(loadConfig({ ...base, MEDIA_URL_TTL_SECONDS: '30' }).playback.urlTtlSeconds).toBe(30);
      expect(loadConfig({ ...base, MEDIA_URL_TTL_SECONDS: '3600' }).playback.urlTtlSeconds).toBe(
        3600,
      );
      for (const bad of ['29', '3601', '1.5', 'abc']) {
        expect(() => loadConfig({ ...base, MEDIA_URL_TTL_SECONDS: bad })).toThrow(ConfigError);
      }
    });
  });

  describe('loopback bind while authentication is disabled', () => {
    it('defaults to 127.0.0.1 and accepts loopback addresses', () => {
      expect(loadConfig(base).host).toBe('127.0.0.1');
      for (const host of ['127.0.0.1', '::1', 'localhost']) {
        expect(loadConfig({ ...base, API_HOST: host }).host).toBe(host);
      }
    });

    it('rejects non-loopback hosts, naming API_HOST only', () => {
      for (const host of ['0.0.0.0', '::', '192.168.1.20', 'api.example.test']) {
        try {
          loadConfig({ ...base, API_HOST: host });
          throw new Error('expected failure');
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).variables).toEqual(['API_HOST']);
          expect((error as Error).message).not.toContain(host);
        }
      }
    });
  });

  it('parses CORS origins as a list of URLs', () => {
    expect(
      loadConfig({ ...base, API_CORS_ORIGINS: 'http://a.test, http://b.test' }).corsOrigins,
    ).toEqual(['http://a.test', 'http://b.test']);
    expect(() => loadConfig({ ...base, API_CORS_ORIGINS: '*' })).toThrow(ConfigError);
  });
});
