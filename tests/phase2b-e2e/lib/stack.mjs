// Real-stack harness: guarded test DB, throwaway storage, Redis DB 14, audio container, API, orchestrator.
// Secrets (audio token, signing secret) are generated in-process, passed only through child
// environments, and never printed or written to a file.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const COMPOSE = [
  'compose',
  '-p',
  'vip-p2b-e2e',
  '-f',
  join(REPO, 'infra/docker/compose.yaml'),
  '--env-file',
  join(REPO, '.env'),
  '--profile',
  'audio',
];
export const IMAGE = 'vip-p2b-e2e-audio-service';
export const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'; // seeded dev workspace id
export const API_PORT = 3917;
export const AUDIO_URL = 'http://127.0.0.1:8001';
export const API_BASE = `http://127.0.0.1:${API_PORT}/api/v1/workspaces/${WORKSPACE_ID}`;

const DEFAULT_SCRATCH =
  '/private/tmp/claude-501/-Users-joydeepsingh-voice-intelligence-platform/40376644-792f-4829-9cef-f025d3692b5d/scratchpad/phase2b-e2e';
export const SCRATCH = process.env.P2B_SCRATCH ?? DEFAULT_SCRATCH;
export const STORAGE = join(SCRATCH, 'storage');
export const LOGS = join(SCRATCH, 'logs');
export const FIXTURES = join(SCRATCH, 'fixtures');

export const secrets = {
  audioToken: randomBytes(32).toString('hex'),
  signing: randomBytes(32).toString('hex'),
};

const children = [];
const dbRequire = createRequire(join(REPO, 'packages/db/package.json'));

export function testDbUrl() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url)
    throw new Error('TEST_DATABASE_URL is not set (run with node --env-file-if-exists=.env).');
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) throw new Error(`refusing database "${name}": must end in _test`);
  return url;
}
export const testDbName = () => new URL(testDbUrl()).pathname.replace(/^\//, '');

export function redisUrl() {
  const u = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  u.pathname = '/14';
  return u.toString();
}

export async function openDb() {
  const db = await import(pathToFileURL(join(REPO, 'packages/db/dist/index.js')).href);
  const handle = db.createDb(testDbUrl(), { maxConnections: 3 });
  return { ...db, handle, d: handle.db };
}

export async function resetDatabase() {
  const db = await openDb();
  const { sql, d } = db;
  await d.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  await d.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
  await d.execute(sql`CREATE SCHEMA public`);
  await db.runMigrations(d);
  await db.seedDevelopment(d);
  return db;
}

export async function flushRedis() {
  const IORedis = createRequire(join(REPO, 'apps/api/package.json'))('ioredis');
  const r = new (IORedis.default ?? IORedis)(redisUrl());
  await r.flushdb();
  await r.quit();
}

export function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}
export const docker = (...args) => sh('docker', args);

export function prepareDirs() {
  rmSync(STORAGE, { recursive: true, force: true });
  rmSync(LOGS, { recursive: true, force: true });
  for (const d of [STORAGE, LOGS, FIXTURES, join(STORAGE, 'recordings'), join(STORAGE, 'derived')])
    mkdirSync(d, { recursive: true });
}

function composeEnv() {
  return {
    ...process.env,
    AUDIO_SERVICE_TOKEN: secrets.audioToken,
    AUDIO_STORAGE_HOST_ROOT: STORAGE,
  };
}

export function startAudio() {
  const r = sh('docker', [...COMPOSE, 'up', '-d', '--build', 'audio-service'], {
    env: composeEnv(),
  });
  if (r.status !== 0) throw new Error(`compose up failed: ${redact(r.stderr).slice(-500)}`);
}
export const audioContainer = () =>
  docker(
    'ps',
    '-q',
    '--filter',
    'label=com.docker.compose.project=vip-p2b-e2e',
    '--filter',
    'label=com.docker.compose.service=audio-service',
  ).stdout.trim();

export function stopAudio() {
  sh('docker', [...COMPOSE, 'rm', '-sf', 'audio-service'], { env: composeEnv() });
  sh('docker', ['network', 'rm', 'vip-p2b-e2e_vip-audio-dev']);
}

export function redact(s) {
  return String(s ?? '')
    .split(secrets.audioToken)
    .join('[token]')
    .split(secrets.signing)
    .join('[secret]');
}

function spawnNode(name, entry, cwd, env) {
  const out = createWriteStream(join(LOGS, `${name}.log`), { flags: 'a' });
  const child = spawn(process.execPath, [entry], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(out, { end: false });
  child.stderr.pipe(out, { end: false });
  child.on('exit', () => out.end());
  children.push(child);
  return child;
}

function baseEnv() {
  // Deliberately NOT inheriting the process env: nothing from .env can leak through.
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    DATABASE_URL: testDbUrl(),
    REDIS_URL: redisUrl(),
    AUDIO_SERVICE_URL: AUDIO_URL,
    AUDIO_SERVICE_TOKEN: secrets.audioToken,
    AUDIO_SERVICE_TIMEOUT_MS: '5000',
  };
}

export function apiEnv() {
  return {
    ...baseEnv(),
    AUTH_MODE: 'dev',
    DEV_WORKSPACE_ID: WORKSPACE_ID,
    API_HOST: '127.0.0.1',
    API_PORT: String(API_PORT),
    STORAGE_LOCAL_ROOT: STORAGE,
    UPLOAD_MAX_BYTES: String(4 * 1024 ** 3),
    UPLOAD_PART_SIZE_BYTES: String(16 * 1024 ** 2),
    MEDIA_URL_SIGNING_SECRET: secrets.signing,
    PROCESSING_MAX_RETRIES: '3',
  };
}
export function orchEnv(extra = {}) {
  return {
    ...baseEnv(),
    PROCESSING_POLL_INTERVAL_MS: '500',
    PROCESSING_RETRY_BACKOFF_MS: '1000',
    QUEUE_AUDIO_BACKOFF_MS: '1000',
    PROCESSING_TASK_TIMEOUT_MS: '3600000',
    ...extra,
  };
}

export const apiProc = { child: null };
export const orchProc = { child: null };
export function startApi() {
  apiProc.child = spawnNode(
    'api',
    join(REPO, 'apps/api/dist/main.js'),
    join(REPO, 'apps/api'),
    apiEnv(),
  );
}
export function startOrchestrator(extra) {
  orchProc.child = spawnNode(
    'orchestrator',
    join(REPO, 'apps/orchestrator/dist/main.js'),
    join(REPO, 'apps/orchestrator'),
    orchEnv(extra),
  );
}
export async function stopOrchestrator() {
  const c = orchProc.child;
  if (!c || c.exitCode !== null) return;
  c.kill('SIGTERM');
  await new Promise((res) => {
    c.on('exit', res);
    setTimeout(() => {
      c.kill('SIGKILL');
      res();
    }, 15000);
  });
}

export async function waitUntil(
  fn,
  { timeoutMs = 60000, intervalMs = 250, what = 'condition' } = {},
) {
  const end = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end)
      throw new Error(`timeout waiting for ${what}${last ? `: ${last.message}` : ''}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function waitReady() {
  await waitUntil(async () => (await fetch(`${AUDIO_URL}/health/live`)).ok, {
    what: 'audio service',
    timeoutMs: 90000,
  });
  await waitUntil(async () => (await fetch(`http://127.0.0.1:${API_PORT}/api/v1/health/live`)).ok, {
    what: 'api',
  });
}

export async function teardown() {
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  stopAudio();
}
export const logPath = (n) => join(LOGS, `${n}.log`);
export { createReadStream, existsSync };
