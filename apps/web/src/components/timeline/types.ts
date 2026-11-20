/**
 * UI-side shapes for the transcript workspace timeline (audio-visualisation.md). They are
 * placeholders for component props only: the API contracts for segments, speakers, diagnostics
 * and uncertainty arrive with the pipeline, and will replace these via `@vip/contracts`.
 * Times are integer ms relative to the original recording (FR-2.3).
 */
export interface TimeWindow {
  fromMs: number;
  toMs: number;
}

export interface SpeakerTurn {
  speakerKey: string;
  displayName: string | null;
  startMs: number;
  endMs: number;
}

/** Audio Quality Agent output (A1). Never mixed with transcription uncertainty (FR-9.3). */
export interface AudioDiagnosticFlag {
  kind: 'noise' | 'clipping' | 'distortion' | 'dropout' | 'silence' | 'low_level';
  severity: 'low' | 'medium' | 'high';
  startMs: number;
  endMs: number;
}

/** Transcription Agent output (A2). A separate channel from audio diagnostics. */
export interface UncertaintySpan {
  kind:
    | 'low_confidence'
    | 'inaudible'
    | 'overlapping_speech'
    | 'language_uncertain'
    | 'speaker_uncertain';
  startMs: number;
  endMs: number;
}

export interface TimelineData {
  durationMs: number | null;
  speakers: SpeakerTurn[];
  diagnostics: AudioDiagnosticFlag[];
  uncertainties: UncertaintySpan[];
}
