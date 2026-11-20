import { ConfigError, loadConfig } from './app-config';

const base = {
  AUTH_MODE: 'dev',
  DEV_WORKSPACE_ID: '00000000-0000-4000-8000-000000000001',
  DATABASE_URL: 'postgres://u:secret-password@127.0.0.1:5432/vip',
  REDIS_URL: 'redis://127.0.0.1:6379',
  AUDIO_SERVICE_URL: 'http://127.0.0.1:8001/',
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

  it('parses CORS origins as a list of URLs', () => {
    expect(
      loadConfig({ ...base, API_CORS_ORIGINS: 'http://a.test, http://b.test' }).corsOrigins,
    ).toEqual(['http://a.test', 'http://b.test']);
    expect(() => loadConfig({ ...base, API_CORS_ORIGINS: '*' })).toThrow(ConfigError);
  });
});
