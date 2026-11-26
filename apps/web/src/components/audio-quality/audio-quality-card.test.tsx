import type { AudioDiagnosticsSnapshot } from '@vip/contracts';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AudioQualityCard } from './audio-quality-card';
import { flagRange, formatOffset } from './model';

const ID = '00000000-0000-4000-8000-000000000001';

const snapshot = (over: Partial<AudioDiagnosticsSnapshot> = {}): AudioDiagnosticsSnapshot => ({
  runId: ID,
  state: 'completed',
  stage: { attempt: 1, error: null },
  measurementSet: null,
  diagnostics: {
    summary: {
      schemaVersion: 1,
      diagnosticsId: ID,
      runId: ID,
      preprocessingId: ID,
      ruleVersion: 'a1-rules-0.1-provisional',
      provisional: true,
      overall: 'poor',
      confidence: 'medium',
      suitability: {
        transcription: { value: 'unreliable', reasons: ['noise', 'language_id_risk'] },
        diarization: { value: 'limited', reasons: ['noise'] },
      },
      flagCounts: { noise: { high: 1 }, silence: { low: 1 } },
      affectedRatio: 0.4,
      notAssessed: [
        { dimension: 'distortion', reason: 'no_reference_free_detector' },
        { dimension: 'reverberation', reason: 'not_supported_v1' },
      ],
      tier1: 'available',
      createdAt: '2026-11-26T12:00:00.000Z',
    },
    recommendations: [{ code: 'reduce_background_noise' }],
    flags: [
      {
        id: '00000000-0000-4000-8000-000000000002',
        kind: 'silence',
        severity: 'low',
        startMs: 60_000,
        endMs: 70_000,
        basis: 'derived',
        ruleId: 'silence.region',
        measurementRefs: [],
      },
      {
        id: '00000000-0000-4000-8000-000000000003',
        kind: 'noise',
        severity: 'high',
        startMs: 10_000,
        endMs: 20_000,
        basis: 'estimate',
        ruleId: 'noise.snr_region',
        measurementRefs: [],
      },
    ],
    measurements: [],
    tier1Record: null,
  },
  ...over,
});

describe('AudioQualityCard (A1, ADR-0043)', () => {
  it('shows no provisional label for an assessment with approved rules (a1-rules-1.0, ADR-0048)', () => {
    const s = snapshot();
    const approved = {
      ...s,
      diagnostics: {
        ...s.diagnostics!,
        summary: { ...s.diagnostics!.summary, ruleVersion: 'a1-rules-1.0', provisional: false },
      },
    };
    render(<AudioQualityCard load={{ status: 'ready', snapshot: approved }} />);
    expect(screen.getByText('Poor')).toBeInTheDocument();
    expect(screen.queryByText(/provisional thresholds/i)).not.toBeInTheDocument();
  });

  it('shows the class, categorical confidence, provisional label, suitability and recommendations', () => {
    render(<AudioQualityCard load={{ status: 'ready', snapshot: snapshot() }} />);
    expect(screen.getByText('Poor')).toBeInTheDocument();
    expect(
      screen.getByText(/confidence: medium \(rule-based, not a probability\)/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/provisional thresholds/i)).toBeInTheDocument();
    expect(
      screen.getByText(/heavy noise can make language identification harder/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/record in a quieter place/i)).toBeInTheDocument();
    expect(
      screen.getByText(/not assessed: distortion other than clipping, reverberation and echo/i),
    ).toBeInTheDocument();
  });

  it('lists significant problems with severity in text and the evidence basis; counts low ones', () => {
    render(<AudioQualityCard load={{ status: 'ready', snapshot: snapshot() }} />);
    const items = screen.getAllByRole('listitem').filter((li) => li.textContent?.includes('·'));
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toMatch(/High.*Background noise.*0:10–0:20.*Estimated/);
    expect(
      screen.getByText(/1 low-severity observation \(\s*silence\s*\) do not affect/i),
    ).toBeInTheDocument();
  });

  it('never uses transcription-uncertainty wording or a numeric score', () => {
    const { container } = render(
      <AudioQualityCard load={{ status: 'ready', snapshot: snapshot() }} />,
    );
    expect(container.textContent).not.toMatch(/uncertain segment|low confidence segment|%/i);
    expect(container.innerHTML).not.toMatch(/uncert-/);
  });

  it('shows honest pending, failed and missing states, and offers a retry only when allowed', () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <AudioQualityCard
        load={{ status: 'ready', snapshot: snapshot({ state: 'pending', diagnostics: null }) }}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText(/will start shortly/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    rerender(
      <AudioQualityCard
        load={{ status: 'ready', snapshot: snapshot({ state: 'failed', diagnostics: null }) }}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText(/transcription is not affected/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry assessment/i }));
    expect(onRetry).toHaveBeenCalledOnce();
    rerender(<AudioQualityCard load={{ status: 'none' }} />);
    expect(screen.getByText(/once the recording has a run/i)).toBeInTheDocument();
  });

  it('formats offsets and whole-recording ranges', () => {
    expect(formatOffset(3_725_000)).toBe('1:02:05');
    expect(flagRange(null, null)).toBe('Whole recording');
  });
});
