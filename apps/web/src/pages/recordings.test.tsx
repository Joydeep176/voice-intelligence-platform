import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ToastProvider } from '@/components/toaster';
import { json, mockFetch, problem, recording } from '@/test/mock-api';
import RecordingsPage from './recordings';

const renderPage = () =>
  render(
    <ToastProvider>
      <RecordingsPage />
    </ToastProvider>,
  );

describe('RecordingsPage', () => {
  it('shows a loading state while the list loads', () => {
    mockFetch(() => new Promise<Response>(() => {}));
    renderPage();
    expect(screen.getByRole('status')).toHaveTextContent('Loading recordings');
  });

  it('shows an error with retry, then recovers', async () => {
    let calls = 0;
    mockFetch(() =>
      ++calls === 1
        ? problem(500, 'INTERNAL_ERROR')
        : json(200, { items: [recording()], nextCursor: null }),
    );
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('The server had a problem');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: /synthetic-tone\.wav/ })).toBeInTheDocument();
  });

  it('shows an empty state with an upload action', async () => {
    mockFetch(() => json(200, { items: [], nextCursor: null }));
    renderPage();
    expect(await screen.findByText('No recordings yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Upload your first recording' })).toHaveAttribute(
      'href',
      '/recordings/new',
    );
  });

  it('loads further pages with the cursor', async () => {
    const second = recording({
      id: '33333333-3333-4333-8333-333333333333',
      originalFilename: 'second.wav',
    });
    mockFetch((_m, url) =>
      url.searchParams.get('cursor') === 'c1'
        ? json(200, { items: [second], nextCursor: null })
        : json(200, { items: [recording()], nextCursor: 'c1' }),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('link', { name: /second\.wav/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});
