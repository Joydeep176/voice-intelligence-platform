import { createHmac } from 'node:crypto';
import {
  signPlaybackToken,
  verifyPlaybackToken,
  type PlaybackTokenPayload,
} from './playback-token';

const SECRET = 'test-only-media-url-signing-secret-000000000000';
const R = '6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b10';
const W = '00000000-0000-4000-8000-000000000001';
const NOW = 1_800_000_000;
const payload: PlaybackTokenPayload = { v: 1, r: R, w: W, exp: NOW + 300 };

/** Builds a correctly signed token around an arbitrary payload value. */
function signed(value: unknown, secret = SECRET): string {
  const segment = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString(
    'base64url',
  );
  return `${segment}.${createHmac('sha256', secret).update(segment).digest('base64url')}`;
}

describe('playback token', () => {
  it('round-trips', () => {
    expect(verifyPlaybackToken(signPlaybackToken(payload, SECRET), SECRET, NOW)).toEqual(payload);
  });

  it('rejects a tampered payload', () => {
    const [, sig] = signPlaybackToken(payload, SECRET).split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload, w: R })).toString('base64url');
    expect(verifyPlaybackToken(`${forged}.${sig}`, SECRET, NOW)).toBeNull();
  });

  it('rejects a tampered or truncated signature', () => {
    const [seg, sig] = signPlaybackToken(payload, SECRET).split('.') as [string, string];
    const flipped = `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyPlaybackToken(`${seg}.${flipped}`, SECRET, NOW)).toBeNull();
    expect(verifyPlaybackToken(`${seg}.${sig.slice(0, -2)}`, SECRET, NOW)).toBeNull();
    expect(verifyPlaybackToken(`${seg}.${sig}AA`, SECRET, NOW)).toBeNull();
  });

  it('rejects the wrong secret', () => {
    const token = signPlaybackToken(payload, SECRET);
    expect(verifyPlaybackToken(token, `${SECRET}x`, NOW)).toBeNull();
  });

  it('rejects expired tokens, including exactly at expiry', () => {
    const token = signPlaybackToken(payload, SECRET);
    expect(verifyPlaybackToken(token, SECRET, payload.exp - 1)).toEqual(payload);
    expect(verifyPlaybackToken(token, SECRET, payload.exp)).toBeNull();
    expect(verifyPlaybackToken(token, SECRET, payload.exp + 1)).toBeNull();
  });

  it.each<[string, unknown]>([
    ['empty', ''],
    ['non-string', undefined],
    ['one segment', 'abcdef'],
    ['three segments', 'a.b.c'],
    ['empty segment', 'abc.'],
    ['non-base64url', 'ab+c/d==.ef$g'],
    ['oversize', `${'a'.repeat(600)}.${'b'.repeat(43)}`],
    ['bad JSON', signed('not json')],
    ['JSON array', signed([1])],
    ['JSON null', signed('null')],
    ['wrong version', signed({ ...payload, v: 2 })],
    ['missing version', signed({ r: R, w: W, exp: payload.exp })],
    ['non-UUID recording', signed({ ...payload, r: '../etc/passwd' })],
    ['non-UUID workspace', signed({ ...payload, w: 'nope' })],
    ['non-integer exp', signed({ ...payload, exp: payload.exp + 0.5 })],
    ['string exp', signed({ ...payload, exp: String(payload.exp) })],
  ])('rejects malformed input: %s', (_name, token) => {
    expect(verifyPlaybackToken(token, SECRET, NOW)).toBeNull();
  });
});
