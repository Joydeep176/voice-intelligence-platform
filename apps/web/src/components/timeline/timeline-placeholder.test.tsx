import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TimelinePlaceholder } from './timeline-placeholder';

describe('TimelinePlaceholder copy', () => {
  it('does not call any implemented track a later phase', () => {
    const { container } = render(
      <TimelinePlaceholder
        data={{ durationMs: 1000, speakers: [], diagnostics: [], uncertainties: [] }}
      />,
    );
    const lane = (label: string) => screen.getByText(label).closest('li')!;
    expect(lane('Speakers')).toHaveTextContent(/listed in the Transcript section/);
    expect(lane('Speakers')).not.toHaveTextContent(/later phase/);
    expect(lane('Transcription uncertainty')).toHaveTextContent(/Transcript segments/);
    expect(lane('Transcription uncertainty')).not.toHaveTextContent(/later phase/);
    // Phase 3A: the audio quality track is live (empty here: no flags).
    expect(lane('Audio quality')).not.toHaveTextContent(/later phase/);
    expect(lane('Audio quality')).toHaveTextContent(/No timestamped audio problems/);
    expect(container.textContent).not.toMatch(/Transcription Agent/);
  });

  it('draws timestamped audio-quality flags with a text alternative and no uncertainty tokens', () => {
    const { container } = render(
      <TimelinePlaceholder
        data={{
          durationMs: 60_000,
          speakers: [],
          diagnostics: [
            { kind: 'noise', severity: 'high', startMs: 10_000, endMs: 20_000 },
            { kind: 'dropout', severity: 'low', startMs: 30_000, endMs: 30_400 },
          ],
          uncertainties: [],
        }}
      />,
    );
    const bars = screen.getAllByTestId('diagnostic-bar');
    expect(bars).toHaveLength(2);
    expect(parseFloat(bars[0]!.style.left)).toBeCloseTo((10_000 / 60_000) * 100, 3);
    expect(bars[0]!.className).toMatch(/bg-diag-high/);
    expect(screen.getByRole('list', { name: 'Timestamped audio problems' })).toHaveTextContent(
      /High Background noise, 0:10–0:20/,
    );
    expect(bars.every((b) => !/uncert/.test(b.className))).toBe(true);
    expect(container).toBeTruthy();
  });
});
