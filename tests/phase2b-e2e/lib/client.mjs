import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { basename } from 'node:path';
import { API_BASE } from './stack.mjs';

const PART = 16 * 1024 ** 2;
const MIME = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
};

export async function api(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

/** Chunked upload flow with consent. Returns { id, sha256, complete } (complete = response of /upload/complete). */
export async function upload(path, { name = basename(path), mimeType } = {}) {
  const size = statSync(path).size;
  const ext = name.split('.').pop();
  const created = await api('POST', '/recordings', {
    filename: name,
    mimeType: mimeType ?? MIME[ext],
    sizeBytes: size,
    consent: { statementVersion: 'dev-2026-11', attested: true },
  });
  if (created.status !== 201) return { id: null, created, sha256: await sha256File(path) };
  const id = created.json.recording.id;
  const total = created.json.upload.totalParts;
  const partSize = created.json.upload.partSize;
  const fd = openSync(path, 'r');
  try {
    for (let n = 1; n <= total; n++) {
      const len = Math.min(partSize, size - (n - 1) * partSize);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, (n - 1) * partSize);
      const res = await fetch(`${API_BASE}/recordings/${id}/upload/parts/${n}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(len) },
        body: buf,
      });
      if (res.status !== 200 && res.status !== 201)
        throw new Error(`part ${n} failed: ${res.status}`);
    }
  } finally {
    closeSync(fd);
  }
  const complete = await api('POST', `/recordings/${id}/upload/complete`);
  return { id, created, complete, sha256: await sha256File(path) };
}
export const snapshot = (id) => api('GET', `/recordings/${id}/processing`);
export const getRecording = (id) => api('GET', `/recordings/${id}`);
