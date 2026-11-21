import { describe, expect, it } from 'vitest';
import { detectFamily, familyOf, sniffFile } from './sniff';

const bytes = (...parts: (string | number[])[]) => {
  const out = new Uint8Array(16);
  let at = 0;
  for (const p of parts) {
    const arr = typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p;
    out.set(arr, at);
    at += arr.length;
  }
  return out;
};

describe('detectFamily', () => {
  it('recognises each supported container', () => {
    expect(detectFamily(bytes('RIFF', [0, 0, 0, 0], 'WAVE'))).toBe('wav');
    expect(detectFamily(bytes('fLaC'))).toBe('flac');
    expect(detectFamily(bytes('OggS'))).toBe('ogg');
    expect(detectFamily(bytes([0, 0, 0, 0x20], 'ftypM4A '))).toBe('mp4');
    expect(detectFamily(bytes([0x1a, 0x45, 0xdf, 0xa3]))).toBe('webm');
    expect(detectFamily(bytes('ID3'))).toBe('mp3');
    expect(detectFamily(bytes([0xff, 0xfb]))).toBe('mp3');
  });

  it('rejects RIFF that is not WAVE and unknown or empty content', () => {
    expect(detectFamily(bytes('RIFF', [0, 0, 0, 0], 'AVI '))).toBeNull();
    expect(detectFamily(bytes('%PDF-1.7'))).toBeNull();
    expect(detectFamily(new Uint8Array(16))).toBeNull();
    expect(detectFamily(new Uint8Array(0))).toBeNull();
  });
});

describe('familyOf', () => {
  it.each([
    ['audio/wav', 'wav'],
    ['audio/x-wav', 'wav'],
    ['audio/mpeg', 'mp3'],
    ['audio/mp4', 'mp4'],
    ['audio/x-m4a', 'mp4'],
    ['audio/flac', 'flac'],
    ['audio/ogg', 'ogg'],
    ['audio/webm', 'webm'],
  ] as const)('%s -> %s', (mime, family) => {
    expect(familyOf(mime as never)).toBe(family);
  });
});

describe('sniffFile', () => {
  it('reads a local blob without network access', async () => {
    const calls: unknown[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = ((...a: unknown[]) => (calls.push(a), orig(...(a as [string])))) as never;
    try {
      expect(await sniffFile(new Blob([bytes('fLaC')]))).toBe('flac');
      expect(await sniffFile(new Blob(['plain text file']))).toBeNull();
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
