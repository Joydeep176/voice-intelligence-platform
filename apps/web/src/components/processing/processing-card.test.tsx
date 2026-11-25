import type { ProcessingSnapshot } from '@vip/contracts';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, mockFetch, problem } from '@/test/mock-api';
import { cancelled, completed, failed, iso, NOW, pre, processing, REC_ID, snap } from './fixtures';
import { ProcessingCard } from './processing-card';

const PATH = new RegExp(`/recordings/${REC_ID}/processing`);

/** Serves `states` in order for GET (the last one repeats); POSTs go to `post`. */
function serve(
  states: ProcessingSnapshot[],
  post: (path: string) => Response = () => problem(500, 'INTERNAL_ERROR'),
) {
  let i = 0;
  return mockFetch((method, url) => {
    if (!PATH.test(url.pathname)) return undefined;
    if (method === 'POST') return post(url.pathname);
    return json(200, states[Math.min(i++, states.length - 1)]);
  });
}

const renderCard = () => render(<ProcessingCard recordingId={REC_ID} />);
const badge = () =>
  screen.getByText(
    /^(Not started|Validating|Queued|Processing|Completed|Failed|Cancelled|Cancelling)/,
  );
const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  document.dispatchEvent(new Event('visibilitychange'));
};
const gets = (fn: ReturnType<typeof serve>) =>
  fn.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === 'GET').length;

afterEach(() => {
  vi.useRealTimers();
  setHidden(false);
});

describe('ProcessingCard states', () => {
  it.each([
    ['not started', snap('not_started'), 'Not started'],
    ['validating', snap('validating'), 'Validating'],
    ['queued', snap('queued', { preprocessing: pre() }), 'Queued'],
    ['processing', processing(0.4), 'Processing · Decoding'],
    ['completed', completed(), 'Completed'],
    ['failed', failed(), 'Failed'],
    ['cancelled', cancelled(), 'Cancelled'],
  ])('shows the %s status', async (_n, state, label) => {
    serve([state]);
    renderCard();
    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Audio processing status' })).toHaveTextContent(
      `Audio processing: ${label}`,
    );
  });

  it('shows Cancelling… while cancellation is requested', async () => {
    const s = processing(0.4);
    s.preprocessing!.cancelRequested = true;
    serve([s]);
    renderCard();
    expect(await screen.findByText('Cancelling…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel processing' })).not.toBeInTheDocument();
  });

  it('shows a determinate bar only from a persisted fraction', async () => {
    serve([processing(0.42)]);
    renderCard();
    const bar = await screen.findByRole('progressbar', { name: 'Processing progress' });
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('is indeterminate with no percentage when the fraction is unknown', async () => {
    serve([processing(null)]);
    renderCard();
    const bar = await screen.findByRole('progressbar', { name: 'Processing progress' });
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar).toHaveAttribute('data-state', 'indeterminate');
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
    expect(screen.getByText('Progress not reported yet')).toBeInTheDocument();
  });

  it('warns when the last update is older than 60 seconds', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    serve([processing(0.4, iso(-61_000))]);
    renderCard();
    expect(await screen.findByText('No update received')).toBeInTheDocument();
    expect(screen.getByText(/No progress update has been received/)).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('does not warn for a fresh update', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    serve([processing(0.4, iso(-30_000))]);
    renderCard();
    await screen.findByText('Processing · Decoding');
    expect(screen.queryByText('No update received')).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('explains a failure in plain language with the retries left', async () => {
    serve([failed({ error: { code: 'CORRUPT_MEDIA', retryable: false }, attempt: 1 })]);
    renderCard();
    const group = await screen.findByRole('group', { name: 'Processing failure' });
    expect(group).toHaveTextContent('damaged');
    expect(group).toHaveTextContent('Retry is possible. 2 of 3 attempts left.');
    expect(group).not.toHaveTextContent('CORRUPT_MEDIA');
  });

  it('shows an invalid recording as a plain message without actions', async () => {
    serve([
      snap('failed', { recording: { status: 'invalid', validationError: 'UNSUPPORTED_FORMAT' } }),
    ]);
    renderCard();
    const group = await screen.findByRole('group', { name: 'Processing failure' });
    expect(group).toHaveTextContent('rejected during validation');
    expect(group).toHaveTextContent('format is not supported');
    expect(group).not.toHaveTextContent('UNSUPPORTED_FORMAT');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows completed details honestly', async () => {
    serve([completed()]);
    renderCard();
    await screen.findByText('Completed');
    expect(screen.getByText('0:10')).toBeInTheDocument();
    expect(screen.getByText('16,000 Hz, 1 channel')).toBeInTheDocument();
    expect(screen.getByText('44,100 Hz, 2 channels')).toBeInTheDocument();
    expect(screen.getByText(/Sample-accurate/)).toBeInTheDocument();
    expect(screen.getByText('Fully decoded')).toBeInTheDocument();
    expect(
      screen.getByText('Voice activity detection not configured — segments not produced'),
    ).toBeInTheDocument();
    expect(screen.getByText('Segments').nextSibling).toHaveTextContent('0');
  });

  it('shows measurements with units and kinds, and unavailable ones with a reason', async () => {
    serve([completed()]);
    renderCard();
    const table = await screen.findByRole('table', {
      name: 'Canonical (16 kHz mono) measurements',
    });
    const peak = within(table).getByRole('row', { name: /Peak dBFS/ });
    expect(peak).toHaveTextContent('-3.2 dBFS');
    expect(peak).toHaveTextContent('measured');
    expect(within(table).getByRole('row', { name: /Crest factor/ })).toHaveTextContent('derived');
    expect(within(table).getByRole('row', { name: /Silence ratio/ })).toHaveTextContent('estimate');
    expect(
      screen.getAllByText(/Snr: unavailable \(no speech\/non-speech split is available\)/),
    ).toHaveLength(1);
  });

  it('describes approximate and uncertain mapping', async () => {
    const approx = completed();
    approx.preprocessing!.timeline = {
      mappingStatus: 'approximate',
      mappingErrorBoundMs: 20,
      decodeClass: 'full',
      decodedUntilMs: null,
      gapCount: 0,
    };
    serve([approx]);
    const { unmount } = renderCard();
    expect(await screen.findByText(/within ±20 ms/)).toBeInTheDocument();
    unmount();

    const uncertain = completed();
    uncertain.preprocessing!.timeline = {
      mappingStatus: 'uncertain',
      mappingErrorBoundMs: null,
      decodeClass: 'partial',
      decodedUntilMs: 5000,
      gapCount: 2,
    };
    serve([uncertain]);
    renderCard();
    expect(await screen.findByText(/2 gaps, decoded until 5000 ms/)).toBeInTheDocument();
    expect(screen.getByText('Partially decoded')).toBeInTheDocument();
  });

  it('never uses verdict language in any state', async () => {
    const verdict = /\b(good|poor|bad|excellent|quality score|score)\b/i;
    for (const s of [snap('not_started'), processing(0.5), completed(), failed(), cancelled()]) {
      serve([s]);
      const { container, unmount } = renderCard();
      await screen.findByLabelText('Processing details');
      expect(container.textContent).not.toMatch(verdict);
      unmount();
    }
  });

  it('shows an error with retry when the first load fails', async () => {
    let calls = 0;
    mockFetch(() =>
      ++calls === 1 ? problem(500, 'INTERNAL_ERROR') : json(200, snap('not_started')),
    );
    const user = userEvent.setup();
    renderCard();
    expect(await screen.findByRole('alert')).toHaveTextContent('The server had a problem');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Not started')).toBeInTheDocument();
  });
});

describe('ProcessingCard polling', () => {
  it('polls every 2 s while active and stops at a terminal state', async () => {
    vi.useFakeTimers();
    const fn = serve([snap('queued', { preprocessing: pre() }), processing(0.2), completed()]);
    renderCard();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(gets(fn)).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(1_999));
    expect(gets(fn)).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(gets(fn)).toBe(2);
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(gets(fn)).toBe(3);
    expect(screen.getByText('Completed')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(gets(fn)).toBe(3);
  });

  it.each([
    ['not started', snap('not_started')],
    ['completed', completed()],
    ['failed', failed()],
    ['cancelled', cancelled()],
  ])('does not poll when %s', async (_n, state) => {
    vi.useFakeTimers();
    const fn = serve([state]);
    renderCard();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(gets(fn)).toBe(1);
  });

  it('pauses while the tab is hidden and resumes with an immediate refresh', async () => {
    vi.useFakeTimers();
    const fn = serve([processing(0.1)]);
    renderCard();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(gets(fn)).toBe(1);
    act(() => setHidden(true));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(gets(fn)).toBe(1);
    act(() => setHidden(false));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(gets(fn)).toBe(2);
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(gets(fn)).toBe(3);
  });

  it('keeps the last state and says so when a refresh fails', async () => {
    vi.useFakeTimers();
    let calls = 0;
    mockFetch(() =>
      ++calls === 1 ? json(200, processing(0.3)) : problem(503, 'DEPENDENCY_UNAVAILABLE'),
    );
    renderCard();
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(screen.getByText('Processing · Decoding')).toBeInTheDocument();
    expect(screen.getByText(/Could not refresh the status/)).toBeInTheDocument();
  });
});

describe('ProcessingCard actions', () => {
  it('starts processing with POST and shows the queued snapshot', async () => {
    const fn = serve([snap('not_started')], () =>
      json(202, snap('queued', { preprocessing: pre() })),
    );
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Start processing' }));
    expect(await screen.findByText('Queued')).toBeInTheDocument();
    const post = fn.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(String(post[0])).toMatch(new RegExp(`/recordings/${REC_ID}/processing$`));
    expect(screen.getByRole('button', { name: 'Cancel processing' })).toBeInTheDocument();
    // Focus moves to the details region after a successful action (the button is gone).
    expect(screen.getByLabelText('Processing details')).toHaveFocus();
  });

  it('accepts 200 for an already completed result', async () => {
    serve([snap('not_started')], () => json(200, completed()));
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Start processing' }));
    expect(await screen.findByText('Completed')).toBeInTheDocument();
  });

  it('disables the actions while a request is in flight', async () => {
    let release: (r: Response) => void = () => {};
    serve([snap('not_started')], () => {
      throw new Error('unused');
    });
    mockFetch((method) =>
      method === 'POST'
        ? new Promise<Response>((r) => (release = r))
        : json(200, snap('not_started')),
    );
    const user = userEvent.setup();
    renderCard();
    const button = await screen.findByRole('button', { name: 'Start processing' });
    await user.click(button);
    expect(button).toBeDisabled();
    await act(async () => release(json(202, snap('queued', { preprocessing: pre() }))));
    expect(await screen.findByText('Queued')).toBeInTheDocument();
  });

  it('shows a readable message for 409 and 503, never raw JSON', async () => {
    const user = userEvent.setup();
    serve([snap('not_started')], () => problem(409, 'INVALID_STATE_TRANSITION', 'raw title'));
    const first = renderCard();
    await user.click(await screen.findByRole('button', { name: 'Start processing' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('cannot be started or retried right now');
    expect(alert.textContent).not.toMatch(/INVALID_STATE_TRANSITION|raw title|\{/);
    expect(alert).toHaveFocus();
    first.unmount();

    serve([snap('not_started')], () => problem(503, 'DEPENDENCY_UNAVAILABLE'));
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Start processing' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('audio service is unavailable');
    expect(screen.getByRole('button', { name: 'Start processing' })).toBeEnabled();
  });

  it('offers retry with the remaining attempts for failed and cancelled', async () => {
    const user = userEvent.setup();
    const fn = serve([failed({ attempt: 2 })], () =>
      json(202, snap('queued', { preprocessing: pre() })),
    );
    const { unmount } = renderCard();
    expect(await screen.findByText('1 retry remaining.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Queued')).toBeInTheDocument();
    expect(fn.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true);
    unmount();

    serve([cancelled({ attempt: 1 })]);
    renderCard();
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByText('2 retries remaining.')).toBeInTheDocument();
  });

  it('hides retry when attempts are exhausted', async () => {
    serve([failed({ attempt: 3, maxRetries: 3 })]);
    renderCard();
    await screen.findByText('Failed');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.getAllByText(/No retries left\./).length).toBeGreaterThan(0);
  });

  it('cancels with POST /cancel, and refreshes on 409', async () => {
    const user = userEvent.setup();
    const fn = serve([processing(0.5)], () => {
      const s = processing(0.5);
      s.state = 'cancelled';
      s.preprocessing = pre({ status: 'cancelled' });
      return json(202, s);
    });
    const { unmount } = renderCard();
    await user.click(await screen.findByRole('button', { name: 'Cancel processing' }));
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
    expect(
      fn.mock.calls.some(
        ([u, init]) => init?.method === 'POST' && String(u).endsWith('/processing/cancel'),
      ),
    ).toBe(true);
    unmount();

    serve([processing(0.5), completed()], () => problem(409, 'INVALID_STATE_TRANSITION'));
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Cancel processing' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('nothing to cancel');
    expect(await screen.findByText('Completed')).toBeInTheDocument();
  });

  it('does not show Start while validating, and no actions when completed', async () => {
    serve([snap('validating')]);
    const { unmount } = renderCard();
    await screen.findByText('Validating');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    unmount();
    serve([completed()]);
    renderCard();
    await screen.findByText('Completed');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(badge()).toBeInTheDocument();
  });
});
