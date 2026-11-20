import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { health, json, mockFetch, recording } from './test/mock-api';

function defaultApi(items = [recording()]) {
  return mockFetch((method, url) => {
    if (url.pathname === '/api/v1/health') return json(200, health);
    if (method === 'GET' && url.pathname.endsWith('/recordings'))
      return json(200, { items, nextCursor: null });
    if (method === 'GET' && /\/recordings\/[0-9a-f-]{36}$/.test(url.pathname))
      return json(200, items[0]);
    return undefined;
  });
}

describe('App', () => {
  it('renders the shell, workspace context and dashboard with live data', async () => {
    defaultApi();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByText('Development workspace')).toBeInTheDocument();
    expect(screen.getByText('Dev mode')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /synthetic-tone\.wav/ })).toBeInTheDocument();
    // System status from /health, with text labels (not colour alone).
    expect(await screen.findByText('Database')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main');
  });

  it('navigates with the sidebar and marks the current page', async () => {
    defaultApi();
    const user = userEvent.setup();
    render(<App />);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    await user.click(within(nav).getByRole('link', { name: 'Recordings' }));
    expect(await screen.findByRole('heading', { name: 'Recordings' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/recordings');
    expect(within(nav).getByRole('link', { name: 'Recordings' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  });

  it('opens a recording and states plainly that it has not been analysed', async () => {
    defaultApi();
    window.history.replaceState(null, '', `/recordings/${recording().id}`);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'synthetic-tone.wav' })).toBeInTheDocument();
    expect(screen.getByText('Not started')).toBeInTheDocument();
    expect(screen.getByText(/not available in this build/i)).toBeInTheDocument();
    expect(screen.getByText('Not yet determined')).toBeInTheDocument();
    // Audio quality and transcription uncertainty are separate sections (FR-9.3).
    expect(screen.getAllByText('Audio quality').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Transcription uncertainty').length).toBeGreaterThan(0);
  });

  it('shows a not-found page for unknown routes', async () => {
    defaultApi();
    window.history.replaceState(null, '', '/nowhere');
    render(<App />);
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
  });
});
