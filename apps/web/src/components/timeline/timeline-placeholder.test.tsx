import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TimelinePlaceholder } from './timeline-placeholder';

describe('TimelinePlaceholder copy', () => {
  it('does not call speakers or uncertainty a later phase, and keeps audio quality later', () => {
    const { container } = render(<TimelinePlaceholder data={{ durationMs: 1000 } as never} />);
    const lane = (label: string) => screen.getByText(label).closest('li')!;
    expect(lane('Speakers')).toHaveTextContent(/listed in the Transcript section/);
    expect(lane('Speakers')).not.toHaveTextContent(/later phase/);
    expect(lane('Transcription uncertainty')).toHaveTextContent(/Transcript segments/);
    expect(lane('Transcription uncertainty')).not.toHaveTextContent(/later phase/);
    expect(lane('Audio quality')).toHaveTextContent(/later phase/);
    expect(container.textContent).not.toMatch(/Transcription Agent/);
  });
});
