import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { completed as processingDone, processing } from '@/components/processing/fixtures';
import { completed as runDone, running, REC_ID, RUN_ID } from '@/components/transcription/fixtures';
import { health, json, mockFetch, recording } from '@/test/mock-api';

// Warm the lazily loaded route so fake timers never wait on a module load.
beforeAll(() => import('@/pages/recording-detail'));
afterEach(() => vi.useRealTimers());

/** Recording stays stale ("validating") until `settled` flips; then it reports "valid". */
function serve(opts: { processing: () => unknown; run: () => unknown }) {
  let settled = false;
  const fn = mockFetch((method, url) => {
    const p = url.pathname;
    if (p === '/api/v1/health') return json(200, health);
    if (method !== 'GET') return undefined;
    if (p.endsWith(`/recordings/${REC_ID}`))
      return json(
        200,
        recording({
          status: settled ? 'valid' : 'validating',
          durationMs: settled ? 75_000 : null,
        }),
      );
    if (p.endsWith(`/recordings/${REC_ID}/processing`)) return json(200, opts.processing());
    if (p.endsWith(`/runs/${RUN_ID}`)) return json(200, opts.run());
    if (p.includes('/transcript') || p.endsWith('/speakers'))
      return json(200, { version: 1, items: [], nextCursor: null });
    return undefined;
  });
  const recordingGets = () =>
    fn.mock.calls.filter(([i]) => String(i).endsWith(`/recordings/${REC_ID}`)).length;
  return { settle: () => (settled = true), recordingGets };
}

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe('recording page refetches on change (not only on the 10 s poll)', () => {
  it('refetches when audio processing completes', async () => {
    vi.useFakeTimers();
    let n = 0;
    const s = serve({
      processing: () => (n++ === 0 ? processing(0.4) : (s.settle(), processingDone())),
      run: () => runDone(),
    });
    window.history.replaceState(null, '', `/recordings/${REC_ID}`);
    render(<App />);
    await tick(50);
    expect(screen.getByText('Validating')).toBeInTheDocument();
    expect(s.recordingGets()).toBe(1);
    await tick(2_500); // processing poll (2 s) completes; the 10 s recording poll has not fired
    expect(s.recordingGets()).toBe(2);
    expect(screen.getByText('Valid')).toBeInTheDocument();
    expect(screen.queryByText('Validating')).not.toBeInTheDocument();
    await tick(2_000); // no loop: unchanged state does not refetch again
    expect(s.recordingGets()).toBe(2);
  });

  it('refetches when the transcription run reaches a terminal status', async () => {
    vi.useFakeTimers();
    let n = 0;
    const s = serve({
      processing: () => processingDone(),
      run: () => (n++ === 0 ? running(0.5) : (s.settle(), runDone())),
    });
    window.history.replaceState(null, '', `/recordings/${REC_ID}`);
    render(<App />);
    await tick(50);
    expect(s.recordingGets()).toBe(1);
    await tick(2_500);
    expect(s.recordingGets()).toBe(2);
    expect(screen.getByText('Valid')).toBeInTheDocument();
  });
});
