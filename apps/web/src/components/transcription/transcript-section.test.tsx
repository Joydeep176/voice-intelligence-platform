import type { RunSnapshot, SpeakerDto, TranscriptPage } from '@vip/contracts';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, mockFetch, problem } from '@/test/mock-api';
import {
  cancelled,
  completed,
  failed,
  page,
  queued,
  REC_ID,
  run,
  RUN_ID,
  running,
  segments,
  speakers,
  SPK_A,
  uncertainties,
} from './fixtures';
import { TranscriptSection } from './transcript-section';

interface Server {
  runs?: RunSnapshot[];
  start?: () => Response;
  cancel?: () => Response;
  retry?: () => Response;
  pages?: TranscriptPage[];
  versions?: unknown;
  speakers?: SpeakerDto[];
  patch?: (body: { displayName: string }) => Response;
  uncertaintiesStatus?: number;
}

/** Serves run snapshots in order (the last repeats) plus the transcript endpoints. */
function serve(s: Server) {
  let i = 0;
  const runs = s.runs ?? [run()];
  const pages = s.pages ?? [page()];
  let p = 0;
  return mockFetch(async (method, url, init) => {
    const path = url.pathname;
    const base = /\/workspaces\/[^/]+/;
    if (!base.test(path)) return undefined;
    if (method === 'POST' && path.endsWith(`/recordings/${REC_ID}/runs`)) {
      return s.start?.() ?? problem(500, 'INTERNAL_ERROR');
    }
    if (method === 'POST' && path.endsWith('/cancel')) return s.cancel?.() ?? problem(500, 'X');
    if (method === 'POST' && path.endsWith('/retry')) return s.retry?.() ?? problem(500, 'X');
    if (method === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as { displayName: string };
      return s.patch?.(body) ?? problem(500, 'X');
    }
    if (path.endsWith(`/runs/${RUN_ID}`)) return json(200, runs[Math.min(i++, runs.length - 1)]);
    if (path.endsWith('/transcript/versions')) {
      return json(200, s.versions ?? { items: [] });
    }
    if (path.endsWith('/transcript/uncertainties')) {
      return s.uncertaintiesStatus
        ? problem(s.uncertaintiesStatus, 'INTERNAL_ERROR')
        : json(200, { version: 1, items: uncertainties, nextCursor: null });
    }
    if (path.endsWith('/transcript')) return json(200, pages[Math.min(p++, pages.length - 1)]);
    if (path.endsWith('/speakers')) return json(200, { items: s.speakers ?? speakers });
    return undefined;
  });
}

const renderSection = (over: { latestRunId?: string | null; preprocessingDone?: boolean } = {}) =>
  render(
    <TranscriptSection
      recordingId={REC_ID}
      latestRunId={over.latestRunId === undefined ? RUN_ID : over.latestRunId}
      preprocessingDone={over.preprocessingDone ?? true}
    />,
  );

const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  document.dispatchEvent(new Event('visibilitychange'));
};
const runGets = (fn: ReturnType<typeof serve>) =>
  fn.mock.calls.filter(
    ([input, init]) =>
      (init?.method ?? 'GET') === 'GET' && String(input).endsWith(`/runs/${RUN_ID}`),
  ).length;
const pill = () =>
  screen.getByText(/^(Not started|Queued|Running|Completed|Failed|Cancelled|Cancelling…)$/);

afterEach(() => {
  vi.useRealTimers();
  setHidden(false);
});

describe('run status', () => {
  it.each([
    ['not started (created run)', run(), 'Not started'],
    ['queued', queued(), 'Queued'],
    ['running', running(0.4), 'Running'],
    ['completed', completed(), 'Completed'],
    ['failed', failed(), 'Failed'],
    ['cancelled', cancelled(), 'Cancelled'],
    ['cancelling', run({ status: 'cancelling' }), 'Cancelling…'],
  ])('shows %s', async (_n, state, label) => {
    serve({ runs: [state] });
    renderSection();
    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(pill()).toHaveTextContent(label);
  });

  it('announces a change of state politely, not the first load', async () => {
    vi.useFakeTimers();
    serve({ runs: [queued(), running(0.2)] });
    renderSection();
    await act(() => vi.advanceTimersByTimeAsync(0));
    const live = screen.getByRole('status', { name: 'Transcription status' });
    expect(live).toHaveTextContent('');
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(live).toHaveTextContent('Transcription: Running');
  });

  it('states the scope plainly and the window source', async () => {
    serve({ runs: [running(0.3)] });
    renderSection();
    expect(
      await screen.findByText('This run covers transcription and speaker diarization only.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Fixed 30 s windows (no preprocessing segments)')).toBeInTheDocument();
  });

  it('describes VAD-based windows', async () => {
    const s = running(0.3);
    s.window = { source: 'vad_segments', windowMs: null, overlapMs: null, count: 4 };
    serve({ runs: [s] });
    renderSection();
    expect(await screen.findByText(/follow voice activity detection segments/)).toBeInTheDocument();
  });

  it('shows no run request when the recording has no run yet', async () => {
    const fn = serve({});
    renderSection({ latestRunId: null });
    expect(await screen.findByText('Not started')).toBeInTheDocument();
    expect(runGets(fn)).toBe(0);
    expect(screen.getByRole('button', { name: 'Start transcription' })).toBeEnabled();
  });
});

describe('per-stage progress', () => {
  it('is determinate only from a persisted fraction', async () => {
    serve({ runs: [running(0.42, 0.1)] });
    renderSection();
    const bar = await screen.findByRole('progressbar', { name: 'Transcription progress' });
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(
      screen.getByRole('progressbar', { name: 'Speaker diarization progress' }),
    ).toHaveAttribute('aria-valuenow', '10');
  });

  it('is indeterminate with no percentage when the fraction is null', async () => {
    serve({ runs: [running(null)] });
    renderSection();
    const bar = await screen.findByRole('progressbar', { name: 'Transcription progress' });
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByText('Progress not reported yet')).toBeInTheDocument();
    // Diarization has not started: waiting, no bar.
    expect(screen.getByText('Waiting')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { name: 'Speaker diarization progress' })).toBeNull();
  });
});

describe('fake provider banner', () => {
  const TEXT =
    'Development placeholder: this transcript was produced by a fake provider and does not reflect the audio.';

  it('is shown for a completed fake run and cannot be dismissed', async () => {
    serve({ runs: [completed(true)] });
    renderSection();
    const banner = await screen.findByTestId('fake-provider-banner');
    expect(banner).toHaveTextContent(TEXT);
    expect(within(banner).queryByRole('button')).toBeNull();
    expect(await screen.findAllByTestId('segment')).toHaveLength(4);
    expect(screen.getAllByTestId('fake-provider-banner')).toHaveLength(1);
  });

  it('is shown while a fake run is still running', async () => {
    serve({ runs: [running(0.3)] });
    renderSection();
    expect(await screen.findByTestId('fake-provider-banner')).toBeInTheDocument();
  });

  it('is not shown for a non-fake run', async () => {
    serve({
      runs: [completed(false)],
      pages: [
        page({
          providers: {
            stt: { id: 'x', model: 'm', fake: false },
            diarization: { id: 'x', model: 'm', fake: false },
          },
        }),
      ],
    });
    renderSection();
    await screen.findAllByTestId('segment');
    expect(screen.queryByTestId('fake-provider-banner')).toBeNull();
  });
});

describe('transcript segments', () => {
  it('renders timestamps, speakers, languages and original script', async () => {
    serve({ runs: [completed()] });
    renderSection();
    const items = await screen.findAllByTestId('segment');
    expect(items).toHaveLength(4);
    // Time order, mm:ss and h:mm:ss.
    expect(items[0]).toHaveTextContent('00:05');
    expect(items[3]).toHaveTextContent('1:02:05');
    // Display name when set, speaker key otherwise, and unassigned.
    expect(items[0]).toHaveTextContent('SPEAKER_00');
    expect(items[1]).toHaveTextContent('Interviewer');
    expect(items[3]).toHaveTextContent('Unassigned speaker');
    // Devanagari is rendered unchanged with lang="hi"; English gets lang="en"; mixed has none.
    const hindi = screen.getByText('यह एक परीक्षण पंक्ति है');
    expect(hindi).toHaveAttribute('lang', 'hi');
    expect(screen.getByText('synthetic line 1')).toHaveAttribute('lang', 'en');
    expect(screen.getByText('mixed line यह test hai')).not.toHaveAttribute('lang');
    expect(within(items[1]!).getByText('Hindi')).toBeInTheDocument();
    expect(within(items[0]!).getByText('English')).toBeInTheDocument();
    expect(within(items[2]!).getByText('Mixed')).toBeInTheDocument();
  });

  it('shows no confidence when it is null and shows a reported one', async () => {
    serve({ runs: [completed()] });
    renderSection();
    const items = await screen.findAllByTestId('segment');
    expect(within(items[0]!).queryByText(/Confidence/)).toBeNull();
    expect(within(items[2]!).getByText('Confidence 82%')).toBeInTheDocument();
    expect(screen.getAllByText(/Confidence/)).toHaveLength(1);
  });

  it('marks uncertainty with accessible text and no score when null', async () => {
    serve({ runs: [completed()] });
    renderSection();
    const items = await screen.findAllByTestId('segment');
    await waitFor(() =>
      expect(within(items[0]!).getByText('Overlapping speech')).toBeInTheDocument(),
    );
    expect(items[0]).toHaveTextContent('Uncertainty: Overlapping speech');
    expect(within(items[1]!).getByText('Speaker uncertain')).toBeInTheDocument();
    expect(within(items[2]!).queryByText(/uncertain|Overlapping/i)).toBeNull();
  });

  it('keeps segments and says so when the uncertainty spans fail to load', async () => {
    serve({ runs: [completed()], uncertaintiesStatus: 500 });
    renderSection();
    expect(await screen.findAllByTestId('segment')).toHaveLength(4);
    expect(await screen.findByText(/Uncertainty markers could not be loaded/)).toBeInTheDocument();
  });

  it('pages with a keyset cursor and appends', async () => {
    const fn = serve({
      runs: [completed()],
      pages: [
        page({ items: segments.slice(0, 2), nextCursor: 'cur1' }),
        page({ items: segments.slice(2), nextCursor: null }),
      ],
    });
    const user = userEvent.setup();
    renderSection();
    expect(await screen.findAllByTestId('segment')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getAllByTestId('segment')).toHaveLength(4));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    const urls = fn.mock.calls.map(([u]) => String(u)).filter((u) => /\/transcript\?/.test(u));
    expect(urls[0]).toMatch(/limit=100/);
    expect(urls[1]).toMatch(/cursor=cur1/);
    // Never the whole transcript at once.
    expect(urls.every((u) => /limit=/.test(u))).toBe(true);
  });

  it('shows the version selector only when more than one version exists', async () => {
    const v = (n: number, kind: 'machine' | 'user_correction') => ({
      id: `55555555-5555-4555-8555-00000000000${n}`,
      version: n,
      kind,
      baseVersionId: null,
      createdBy: 'x',
      note: null,
      createdAt: '2026-11-22T10:00:00.000Z',
      segmentCount: 4,
    });
    serve({ runs: [completed()], versions: { items: [v(1, 'machine')] } });
    const first = renderSection();
    await screen.findAllByTestId('segment');
    expect(screen.queryByLabelText('Version')).toBeNull();
    first.unmount();

    serve({ runs: [completed()], versions: { items: [v(1, 'machine'), v(2, 'user_correction')] } });
    renderSection();
    expect(await screen.findByLabelText('Version')).toBeInTheDocument();
  });
});

describe('speaker rename', () => {
  const rowFor = async (key: string) =>
    (await screen.findAllByTestId('speaker-row')).find((r) => r.textContent?.includes(key))!;

  it('keeps the machine key, updates only after success and returns focus', async () => {
    let resolvePatch: (r: Response) => void = () => undefined;
    const fn = serve({ runs: [completed()] });
    const base = fn.getMockImplementation()!;
    fn.mockImplementation(async (input, init) =>
      init?.method === 'PATCH'
        ? new Promise<Response>((r) => (resolvePatch = r))
        : base(input, init),
    );
    const user = userEvent.setup();
    renderSection();
    const row = await rowFor('SPEAKER_00');
    await user.click(within(row).getByRole('button', { name: 'Rename SPEAKER_00' }));
    const input = within(row).getByLabelText('Display name for SPEAKER_00');
    expect(input).toHaveFocus();
    await user.type(input, 'Asha');
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    // Not updated while the request is pending.
    expect(within(row).queryByText('Asha')).toBeNull();
    await act(async () => resolvePatch(json(200, { ...speakers[0], displayName: 'Asha' })));
    await waitFor(() => expect(within(row).getByText('Asha')).toBeInTheDocument());
    expect(row).toHaveTextContent('SPEAKER_00');
    expect(within(row).getByRole('button', { name: 'Rename Asha' })).toHaveFocus();
    // Segment labels use the new display name.
    expect(screen.getAllByTestId('segment').some((s) => s.textContent?.includes('Asha'))).toBe(
      true,
    );
    expect(screen.getByRole('status', { name: 'Transcription status' })).toHaveTextContent(
      'Renamed SPEAKER_00 to Asha',
    );
    const patch = fn.mock.calls.find(([, i]) => i?.method === 'PATCH')!;
    expect(String(patch[0])).toContain(`/speakers/${SPK_A}`);
    expect(JSON.parse(String(patch[1]?.body))).toEqual({ displayName: 'Asha' });
  });

  it('shows the validation message on 422 and does not change the name', async () => {
    serve({ runs: [completed()], patch: () => problem(422, 'VALIDATION_FAILED') });
    const user = userEvent.setup();
    renderSection();
    const row = await rowFor('SPEAKER_00');
    await user.click(within(row).getByRole('button', { name: 'Rename SPEAKER_00' }));
    await user.type(within(row).getByLabelText('Display name for SPEAKER_00'), 'Bad');
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent(
      'Enter a name of 1 to 80 characters.',
    );
    expect(within(row).queryByText('Bad', { selector: 'p' })).toBeNull();
    expect(within(row).getByText('No display name')).toBeInTheDocument();
  });

  it('rejects an empty name before any request', async () => {
    const fn = serve({ runs: [completed()] });
    const user = userEvent.setup();
    renderSection();
    const row = await rowFor('SPEAKER_01');
    await user.click(within(row).getByRole('button', { name: 'Rename Interviewer' }));
    await user.clear(within(row).getByLabelText('Display name for SPEAKER_01'));
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    expect(await within(row).findByRole('alert')).toBeInTheDocument();
    expect(fn.mock.calls.some(([, i]) => i?.method === 'PATCH')).toBe(false);
  });

  it('explains a 409', async () => {
    serve({ runs: [completed()], patch: () => problem(409, 'INVALID_STATE_TRANSITION') });
    const user = userEvent.setup();
    renderSection();
    const row = await rowFor('SPEAKER_00');
    await user.click(within(row).getByRole('button', { name: 'Rename SPEAKER_00' }));
    await user.type(within(row).getByLabelText('Display name for SPEAKER_00'), 'Asha');
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent(/cannot be renamed right now/);
  });

  it('cancels with Escape and restores focus', async () => {
    serve({ runs: [completed()] });
    const user = userEvent.setup();
    renderSection();
    const row = await rowFor('SPEAKER_00');
    await user.click(within(row).getByRole('button', { name: 'Rename SPEAKER_00' }));
    await user.keyboard('{Escape}');
    expect(within(row).getByRole('button', { name: 'Rename SPEAKER_00' })).toHaveFocus();
  });
});

describe('actions', () => {
  it('starts, then follows the queued run', async () => {
    const fn = serve({ runs: [queued()], start: () => json(202, queued()) });
    const user = userEvent.setup();
    renderSection({ latestRunId: null });
    await user.click(await screen.findByRole('button', { name: 'Start transcription' }));
    expect(await screen.findByText('Queued')).toBeInTheDocument();
    const post = fn.mock.calls.find(([, i]) => i?.method === 'POST')!;
    expect(String(post[0])).toMatch(new RegExp(`/recordings/${REC_ID}/runs$`));
    expect(screen.queryByRole('button', { name: 'Start transcription' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('offers no Start button until audio processing has completed', async () => {
    serve({ runs: [run()] });
    renderSection({ preprocessingDone: false });
    expect(await screen.findByText('Not started')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start transcription' })).toBeNull();
    expect(screen.getByText(/once audio processing has completed/)).toBeInTheDocument();
  });

  it('explains a 409 on start in plain language', async () => {
    serve({ runs: [run()], start: () => problem(409, 'INVALID_STATE_TRANSITION') });
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Start transcription' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /audio processing must have completed first/,
    );
    expect(await screen.findByText('Not started')).toBeInTheDocument();
  });

  it('explains a 503 on start', async () => {
    serve({ runs: [run()], start: () => problem(503, 'DEPENDENCY_UNAVAILABLE') });
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Start transcription' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/job queue is unavailable/);
  });

  it('cancels a running run', async () => {
    const cancelling = run({ ...running(0.3), status: 'cancelling' });
    serve({ runs: [running(0.3)], cancel: () => json(202, cancelling) });
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Cancelling…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getByText(/Cancellation requested/)).toBeInTheDocument();
  });

  it('shows the failure by code and offers Retry while retries remain', async () => {
    serve({ runs: [failed({ retryCount: 1 })], retry: () => json(202, queued()) });
    const user = userEvent.setup();
    renderSection();
    expect(
      await screen.findByText('The speech provider did not answer in time.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/2 of 3 retries left/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Queued')).toBeInTheDocument();
  });

  it('hides Retry when the retry limit is reached', async () => {
    serve({ runs: [failed({ retryCount: 3 })] });
    renderSection();
    expect(await screen.findByText('No retries left.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('offers Retry for a cancelled run with retries left', async () => {
    serve({ runs: [cancelled()] });
    renderSection();
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('never uses verdict or quality language', async () => {
    serve({ runs: [completed()] });
    const { container } = renderSection();
    await screen.findAllByTestId('segment');
    expect(container.textContent).not.toMatch(
      /\b(accurate|reliable|good|poor|verified|true|false)\b/i,
    );
  });
});

describe('polling', () => {
  it('polls every 2 s while active and stops at a terminal state', async () => {
    vi.useFakeTimers();
    const fn = serve({ runs: [queued(), running(0.2), completed()] });
    renderSection();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(runGets(fn)).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(1_999));
    expect(runGets(fn)).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(runGets(fn)).toBe(2);
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(runGets(fn)).toBe(3);
    expect(screen.getByText('Completed')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(runGets(fn)).toBe(3);
  });

  it.each([
    ['not started', run()],
    ['completed', completed()],
    ['failed', failed()],
    ['cancelled', cancelled()],
  ])('does not poll when %s', async (_n, state) => {
    vi.useFakeTimers();
    const fn = serve({ runs: [state] });
    renderSection();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(runGets(fn)).toBe(1);
  });

  it('pauses while the tab is hidden and resumes with an immediate refresh', async () => {
    vi.useFakeTimers();
    const fn = serve({ runs: [running(0.1)] });
    renderSection();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(runGets(fn)).toBe(1);
    act(() => setHidden(true));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(runGets(fn)).toBe(1);
    act(() => setHidden(false));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(runGets(fn)).toBe(2);
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(runGets(fn)).toBe(3);
  });

  it('keeps the last state and says so when a refresh fails', async () => {
    vi.useFakeTimers();
    let calls = 0;
    mockFetch(() =>
      ++calls === 1 ? json(200, running(0.3)) : problem(503, 'DEPENDENCY_UNAVAILABLE'),
    );
    renderSection();
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText(/Could not refresh the status/)).toBeInTheDocument();
  });
});

describe('load errors', () => {
  it('shows a retryable error when the run cannot be loaded', async () => {
    mockFetch(() => problem(500, 'INTERNAL_ERROR'));
    renderSection();
    expect(await screen.findByText('Could not load transcription status')).toBeInTheDocument();
  });
});
