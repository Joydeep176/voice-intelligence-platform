import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HealthResponse } from '@vip/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DashboardPage from './dashboard';
import { health, json, mockFetch, recording, run } from '@/test/mock-api';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface Opts {
  pages?: Array<{ items: ReturnType<typeof recording>[]; nextCursor: string | null }>;
  health?: HealthResponse | 'fail' | 'error500' | 'network';
  healthHttp?: number;
  recordingsFail?: boolean;
}

function setup(opts: Opts = {}) {
  const pages = opts.pages ?? [{ items: [recording()], nextCursor: null }];
  let call = 0;
  const cursors: Array<string | null> = [];
  const fn = mockFetch((method, url) => {
    if (url.pathname === '/api/v1/health') {
      if (opts.health === 'fail') return json(400, { status: 400, title: 'down', code: 'DOWN' });
      if (opts.health === 'error500') return json(500, { status: 500, title: 'x', code: 'X' });
      if (opts.health === 'network') return Promise.reject(new TypeError('Failed to fetch'));
      return json(opts.healthHttp ?? 200, opts.health ?? health);
    }
    if (method === 'GET' && url.pathname.endsWith('/recordings')) {
      if (opts.recordingsFail) return json(400, { status: 400, title: 'boom', code: 'BAD' });
      cursors.push(url.searchParams.get('cursor'));
      const page = pages[Math.min(call, pages.length - 1)]!;
      call += 1;
      return json(200, page);
    }
    return undefined;
  });
  return { fn, cursors };
}

const kpi = (label: string) => screen.getByText(label).closest('div')!.parentElement!;

describe('Dashboard page', () => {
  afterEach(() => vi.useRealTimers());

  describe('KPIs', () => {
    it('counts mixed recording and run statuses', async () => {
      const items = [
        recording({ id: id(1) }),
        recording({ id: id(2), latestRun: run({ status: 'created' }) }),
        recording({ id: id(3), latestRun: run({ status: 'completed' }) }),
        recording({ id: id(4), status: 'uploading', latestRun: null }),
        recording({ id: id(5), status: 'invalid', latestRun: null }),
        recording({ id: id(6), status: 'invalid', latestRun: null }),
      ];
      setup({ pages: [{ items, nextCursor: null }] });
      render(<DashboardPage />);
      await waitFor(() => expect(within(kpi('Recordings')).getByText('6')).toBeInTheDocument());
      expect(within(kpi('Awaiting analysis')).getByText('2')).toBeInTheDocument();
      expect(within(kpi('Uploads in progress')).getByText('1')).toBeInTheDocument();
      expect(within(kpi('Rejected uploads')).getByText('2')).toBeInTheDocument();
      expect(screen.queryByText(/Counts cover/)).not.toBeInTheDocument();
    });

    it('aggregates pages by following nextCursor', async () => {
      const { cursors } = setup({
        pages: [
          { items: [recording({ id: id(1) }), recording({ id: id(2) })], nextCursor: 'c1' },
          { items: [recording({ id: id(3) })], nextCursor: null },
        ],
      });
      render(<DashboardPage />);
      await waitFor(() => expect(within(kpi('Recordings')).getByText('3')).toBeInTheDocument());
      expect(cursors).toEqual([null, 'c1']);
    });

    it('shows partial counts with scope text after 5 pages', async () => {
      const { cursors } = setup({
        pages: [{ items: [recording({ id: id(1) })], nextCursor: 'more' }],
      });
      render(<DashboardPage />);
      await waitFor(() => expect(within(kpi('Recordings')).getByText('5+')).toBeInTheDocument());
      expect(cursors).toHaveLength(5);
      expect(within(kpi('Awaiting analysis')).getByText('5+')).toBeInTheDocument();
      expect(within(kpi('Uploads in progress')).getByText('0+')).toBeInTheDocument();
      expect(screen.getByText(/Counts cover the 500 most recent recordings/)).toBeInTheDocument();
    });

    it('has no processed or completed KPI', async () => {
      setup();
      render(<DashboardPage />);
      const summary = await screen.findByRole('region', { name: 'Summary' });
      expect(within(summary).getAllByRole('paragraph')).toHaveLength(4);
      expect(within(summary).queryByText(/processed|completed analysis/i)).not.toBeInTheDocument();
      expect(within(summary).queryByText(/^(processed|completed)/i)).not.toBeInTheDocument();
    });

    it('shows a dash and a single retryable error when recordings fail', async () => {
      setup({ recordingsFail: true });
      render(<DashboardPage />);
      const retry = await screen.findByRole('button', { name: /try again/i });
      expect(retry).toBeInTheDocument();
      expect(screen.getAllByLabelText('Not available')).toHaveLength(4);
    });
  });

  describe('System health', () => {
    const card = () =>
      screen
        .getByRole('heading', { name: 'System health' })
        .closest('[data-slot=card]') as HTMLElement;

    it('says Checking before the response and never Healthy', async () => {
      mockFetch((_m, url) => {
        if (url.pathname === '/api/v1/health') return new Promise(() => {}) as never;
        if (url.pathname.endsWith('/recordings')) return json(200, { items: [], nextCursor: null });
        return undefined;
      });
      render(<DashboardPage />);
      expect(within(card()).getAllByText('Checking…')).toHaveLength(4);
      expect(screen.queryByText(/healthy/i)).not.toBeInTheDocument();
    });

    it('shows all healthy with per-service text', async () => {
      setup();
      render(<DashboardPage />);
      expect(await screen.findByText('All services healthy')).toBeInTheDocument();
      expect(screen.getByText('Healthy · responding')).toBeInTheDocument();
      expect(screen.getByText('Healthy · 2 ms')).toBeInTheDocument();
      expect(screen.getByText('Healthy · 1 ms')).toBeInTheDocument();
      expect(screen.getByText('Healthy · 3 ms')).toBeInTheDocument();
      expect(screen.getByText(/Last checked/)).toBeInTheDocument();
    });

    it('shows Degraded (HTTP 200) when only the audio service is down', async () => {
      setup({
        health: {
          ...health,
          status: 'degraded',
          dependencies: [
            { name: 'postgres', status: 'up', latencyMs: 2, reason: null },
            { name: 'redis', status: 'up', latencyMs: 1, reason: null },
            { name: 'audio-service', status: 'down', latencyMs: null, reason: 'TIMEOUT' },
          ],
        },
      });
      render(<DashboardPage />);
      expect(await screen.findByText('Degraded')).toBeInTheDocument();
      expect(screen.getByText('Unavailable · timed out')).toBeInTheDocument();
      expect(screen.queryByText(/TIMEOUT/)).not.toBeInTheDocument();
      expect(screen.queryByText('All services healthy')).not.toBeInTheDocument();
    });

    it.each(['postgres', 'redis'] as const)(
      'treats HTTP 503 with a full report as an Outage when %s is down',
      async (down) => {
        setup({
          healthHttp: 503,
          health: {
            ...health,
            status: 'down',
            dependencies: health.dependencies.map((d) =>
              d.name === down ? { ...d, status: 'down', latencyMs: null, reason: 'TIMEOUT' } : d,
            ),
          },
        });
        render(<DashboardPage />);
        expect(await screen.findByText('Outage')).toBeInTheDocument();
        expect(screen.getByText('Healthy · responding')).toBeInTheDocument();
        expect(screen.getAllByText('Unavailable · timed out')).toHaveLength(1);
        expect(screen.getAllByText(/^Healthy · \d+ ms$/)).toHaveLength(2);
        expect(screen.queryByText('Not checked — API unreachable')).not.toBeInTheDocument();
        expect(screen.queryByText(/TIMEOUT/)).not.toBeInTheDocument();
      },
    );

    it('maps reasons to fixed copy, hides unknown codes, and omits latency when null', async () => {
      setup({
        healthHttp: 503,
        health: {
          ...health,
          status: 'down',
          dependencies: [
            { name: 'postgres', status: 'down', latencyMs: null, reason: 'UNREACHABLE' },
            { name: 'redis', status: 'down', latencyMs: null, reason: 'ECONNREFUSED_10.0.0.5' },
            { name: 'audio-service', status: 'up', latencyMs: null, reason: null },
          ],
        },
      });
      render(<DashboardPage />);
      expect(await screen.findByText('Unavailable · unreachable')).toBeInTheDocument();
      expect(screen.getByText('Unavailable')).toBeInTheDocument();
      expect(screen.queryByText(/ECONNREFUSED/)).not.toBeInTheDocument();
      expect(screen.getByText('Healthy')).toBeInTheDocument();
      expect(screen.queryByText(/0 ms/)).not.toBeInTheDocument();
    });

    it('drops earlier healthy state when a later poll fails', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let healthCalls = 0;
      mockFetch((_m, url) => {
        if (url.pathname === '/api/v1/health') {
          healthCalls += 1;
          return healthCalls === 1
            ? json(200, health)
            : json(400, { status: 400, title: 'down', code: 'DOWN' });
        }
        if (url.pathname.endsWith('/recordings')) return json(200, { items: [], nextCursor: null });
        return undefined;
      });
      render(<DashboardPage />);
      expect(await screen.findByText('All services healthy')).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(await screen.findByText('Health status unavailable')).toBeInTheDocument();
      expect(healthCalls).toBe(2);
      expect(screen.queryByText(/healthy/i)).not.toBeInTheDocument();
      expect(screen.getByText('Unavailable')).toBeInTheDocument();
      expect(screen.getAllByText('Not checked — API unreachable')).toHaveLength(3);
    });

    it.each(['fail', 'error500', 'network'] as const)(
      'reports the unreachable state when the health request fails (%s)',
      async (mode) => {
        setup({ health: mode });
        render(<DashboardPage />);
        expect(await screen.findByText('Unavailable')).toBeInTheDocument();
        expect(screen.getAllByText('Not checked — API unreachable')).toHaveLength(3);
        expect(screen.queryByText(/healthy/i)).not.toBeInTheDocument();
        expect(within(card()).getByRole('button', { name: /retry/i })).toBeInTheDocument();
      },
    );
  });

  describe('Recent recordings', () => {
    it('shows at most 6 rows, each a link to the detail page with format and size', async () => {
      const items = Array.from({ length: 8 }, (_, i) =>
        recording({
          id: id(i + 1),
          originalFilename: `call-${i + 1}.mp3`,
          mimeType: 'audio/mpeg',
          sizeBytes: 2048,
          latestRun: i === 0 ? null : run(),
        }),
      );
      setup({ pages: [{ items, nextCursor: null }] });
      render(<DashboardPage />);
      const link = await screen.findByRole('link', { name: /call-1\.mp3/ });
      expect(link).toHaveAttribute('href', `/recordings/${id(1)}`);
      const list = link.closest('ul')!;
      expect(within(list).getAllByRole('link')).toHaveLength(6);
      expect(screen.queryByRole('link', { name: /call-7\.mp3/ })).not.toBeInTheDocument();
      expect(within(link).getByText('MP3')).toBeInTheDocument();
      expect(within(link).getByText('2.0 KB')).toBeInTheDocument();
      expect(within(link).getByText('No run')).toBeInTheDocument();
      const second = screen.getByRole('link', { name: /call-2\.mp3/ });
      expect(within(second).queryByText('No run')).not.toBeInTheDocument();
    });

    it('shows a loading state first', () => {
      mockFetch(() => new Promise(() => {}) as never);
      render(<DashboardPage />);
      expect(screen.getByText('Loading recordings')).toBeInTheDocument();
    });

    it('shows an empty state with an upload action', async () => {
      setup({ pages: [{ items: [], nextCursor: null }] });
      render(<DashboardPage />);
      expect(await screen.findByText('No recordings yet')).toBeInTheDocument();
      const main = screen
        .getByRole('heading', { name: 'Recent recordings' })
        .closest('[data-slot=card]') as HTMLElement;
      expect(within(main).getByRole('link', { name: 'Upload recording' })).toHaveAttribute(
        'href',
        '/recordings/new',
      );
    });

    it('shows an error state and retries', async () => {
      const user = userEvent.setup();
      let fail = true;
      mockFetch((_m, url) => {
        if (url.pathname === '/api/v1/health') return json(200, health);
        if (url.pathname.endsWith('/recordings'))
          return fail
            ? json(400, { status: 400, title: 'boom', code: 'BAD' })
            : json(200, { items: [recording()], nextCursor: null });
        return undefined;
      });
      render(<DashboardPage />);
      const retry = await screen.findByRole('button', { name: /try again/i });
      fail = false;
      await user.click(retry);
      expect(await screen.findByRole('link', { name: /synthetic-tone\.wav/ })).toBeInTheDocument();
    });
  });

  describe('Structure', () => {
    it('has one h1 Overview and the expected h2 sections', async () => {
      setup();
      render(<DashboardPage />);
      await screen.findByRole('link', { name: /synthetic-tone\.wav/ });
      const h1 = screen.getAllByRole('heading', { level: 1 });
      expect(h1).toHaveLength(1);
      expect(h1[0]).toHaveAccessibleName('Overview');
      const h2 = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
      expect(h2).toEqual(
        expect.arrayContaining([
          'Recent recordings',
          'System health',
          'What the platform does today',
        ]),
      );
    });

    it('renders no canvas in jsdom and a decorative 2D hero visual', async () => {
      setup();
      const { container } = render(<DashboardPage />);
      await screen.findByRole('link', { name: /synthetic-tone\.wav/ });
      expect(container.querySelector('canvas')).toBeNull();
      const svg = container.querySelector('[data-dashboard-hero] svg');
      expect(svg).not.toBeNull();
      expect(svg).toHaveAttribute('aria-hidden', 'true');
    });
  });
});
