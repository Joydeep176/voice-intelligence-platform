import { PlaybackUrl } from '@vip/contracts';
import { WORKSPACE_ID } from '@/lib/config';

/** Fixed outcomes only: server text is never surfaced (ADR-0033). */
export type PlaybackIssue =
  { ok: true; url: string } | { ok: false; reason: 'not-playable' | 'unavailable' };

/**
 * Issues a short-lived signed playback URL. Every call writes an audit row, so callers issue once
 * per page view and re-issue only after a playback error.
 */
export async function issuePlaybackUrl(
  recordingId: string,
  signal: AbortSignal,
): Promise<PlaybackIssue> {
  try {
    const res = await fetch(`/api/v1/workspaces/${WORKSPACE_ID}/recordings/${recordingId}/audio`, {
      headers: { accept: 'application/json' },
      signal,
    });
    if (res.status === 409) return { ok: false, reason: 'not-playable' };
    if (!res.ok) return { ok: false, reason: 'unavailable' };
    const parsed = PlaybackUrl.safeParse(await res.json());
    return parsed.success
      ? { ok: true, url: parsed.data.url }
      : { ok: false, reason: 'unavailable' };
  } catch {
    // Aborts, network failures and unparseable bodies all end in the same fixed copy.
    return { ok: false, reason: 'unavailable' };
  }
}
