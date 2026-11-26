import type { ProcessingStatus } from '@vip/contracts';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProcessingStatusPanel, uploadCompleted } from './processing-status';

const run = (status: ProcessingStatus['status']) =>
  ({
    id: '00000000-0000-4000-8000-0000000000aa',
    recordingId: '00000000-0000-4000-8000-0000000000bb',
    status,
    currentStage: null,
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt: '2026-11-25T10:00:00.000Z',
    updatedAt: '2026-11-25T10:00:00.000Z',
  }) as ProcessingStatus;

const stepState = (name: string) => {
  const item = within(screen.getByRole('list', { name: 'Workflow steps' }))
    .getByText(name)
    .closest('li')!;
  return item.lastElementChild!.textContent;
};

describe('ProcessingStatusPanel', () => {
  it('reports the implemented steps from the real preprocessing and run states', () => {
    render(<ProcessingStatusPanel run={run('completed')} uploaded processing="completed" />);
    expect(stepState('Ingestion and upload')).toBe('Complete');
    expect(stepState('Validation and preprocessing')).toBe('Complete');
    expect(stepState('Transcription and diarization')).toBe('Complete');
    // Phase 3A: audio quality reports its real state (pending until assessed).
    expect(stepState('Audio quality analysis')).toBe('Pending');
    // Steps of later phases stay honest.
    expect(stepState('Reporting')).toBe('Not available yet');
  });

  it('reports the audio quality analysis step from the A1 assessment state', () => {
    const { rerender } = render(
      <ProcessingStatusPanel
        run={run('created')}
        uploaded
        processing="completed"
        audioQuality="running"
      />,
    );
    expect(stepState('Audio quality analysis')).toBe('In progress');
    rerender(
      <ProcessingStatusPanel
        run={run('created')}
        uploaded
        processing="completed"
        audioQuality="completed"
      />,
    );
    expect(stepState('Audio quality analysis')).toBe('Complete');
    // ADR-0025 as amended by ADR-0044: wording for an assessed, not yet transcribed run.
    expect(
      screen.getByText(/audio assessed; transcription has not been started/i),
    ).toBeInTheDocument();
    rerender(
      <ProcessingStatusPanel
        run={run('created')}
        uploaded
        processing="completed"
        audioQuality="failed"
      />,
    );
    expect(stepState('Audio quality analysis')).toBe('Failed');
  });

  it('shows in-progress and failed states', () => {
    render(<ProcessingStatusPanel run={run('running')} uploaded processing="failed" />);
    expect(stepState('Validation and preprocessing')).toBe('Failed');
    expect(stepState('Transcription and diarization')).toBe('In progress');
  });

  it('shows pending steps for a new upload without claiming the pipeline is missing', () => {
    render(<ProcessingStatusPanel run={run('created')} uploaded processing="not_started" />);
    expect(stepState('Validation and preprocessing')).toBe('Pending');
    expect(stepState('Transcription and diarization')).toBe('Pending');
    expect(screen.queryByText(/not available in this build/i)).toBeNull();
    expect(screen.getByText(/transcription has not been started/i)).toBeInTheDocument();
  });

  it('maps cancelled and failed runs', () => {
    const { rerender } = render(
      <ProcessingStatusPanel run={run('cancelled')} uploaded processing="completed" />,
    );
    expect(stepState('Transcription and diarization')).toBe('Cancelled');
    rerender(<ProcessingStatusPanel run={run('failed')} uploaded processing="completed" />);
    expect(stepState('Transcription and diarization')).toBe('Failed');
  });

  it('treats the upload as complete once validation has started or finished', () => {
    expect(
      ['uploaded', 'validating', 'valid', 'invalid'].every((s) => uploadCompleted(s as never)),
    ).toBe(true);
    expect(uploadCompleted('uploading')).toBe(false);
  });
});
