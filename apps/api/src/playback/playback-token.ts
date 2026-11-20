import { createHmac, timingSafeEqual } from 'node:crypto';

/** Signed, short-lived playback capability (ADR-0033). Pure functions; the clock is injected. */
export interface PlaybackTokenPayload {
  v: 1;
  /** Recording ID. */
  r: string;
  /** Workspace ID. */
  w: string;
  /** Expiry, unix seconds. */
  exp: number;
}

const MAX_TOKEN_LENGTH = 512;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mac(payloadSegment: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payloadSegment).digest();
}

export function signPlaybackToken(payload: PlaybackTokenPayload, secret: string): string {
  const segment = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${segment}.${mac(segment, secret).toString('base64url')}`;
}

/** Returns the payload, or null for anything invalid or expired. Never throws. */
export function verifyPlaybackToken(
  token: unknown,
  secret: string,
  nowSeconds: number,
): PlaybackTokenPayload | null {
  try {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      return null;
    }
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payloadSegment, signatureSegment] = parts as [string, string];
    if (!SEGMENT.test(payloadSegment) || !SEGMENT.test(signatureSegment)) return null;

    const expected = mac(payloadSegment, secret);
    const actual = Buffer.from(signatureSegment, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

    const data: unknown = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
    const { v, r, w, exp } = data as Record<string, unknown>;
    if (
      v !== 1 ||
      typeof r !== 'string' ||
      !UUID.test(r) ||
      typeof w !== 'string' ||
      !UUID.test(w) ||
      typeof exp !== 'number' ||
      !Number.isInteger(exp) ||
      exp <= nowSeconds
    ) {
      return null;
    }
    return { v, r, w, exp };
  } catch {
    return null;
  }
}
