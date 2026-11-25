import type { DiarizationProvider, SpeechToTextProvider } from '@vip/contracts';
import type { Database } from '@vip/db';
import type { RunsConfig } from '../config';
import type { RawStore } from '../providers/raw-store';

/** Everything the run coordinator needs; the clock and log are injectable for tests. IDs and codes only in logs. */
export interface RunDeps {
  db: Database;
  config: RunsConfig;
  store: RawStore;
  stt: SpeechToTextProvider;
  diarization: DiarizationProvider;
  now: () => number;
  log: (event: Record<string, string | number | boolean | null>) => void;
}

export type RunNode = 'transcription' | 'diarization';

/** The run cannot succeed by trying again (bad input, corrupt raw output, invalid provider output). */
export class RunFailure extends Error {
  constructor(
    readonly code: string,
    readonly node: RunNode | null = null,
  ) {
    super(`Run failure: ${code}`);
    this.name = 'RunFailure';
  }
}

/** A failure worth retrying with BullMQ attempts and backoff (timeouts, provider or database hiccups). */
export class TransientRunError extends Error {
  constructor(
    readonly code: string,
    readonly node: RunNode | null = null,
  ) {
    super(`Transient run failure: ${code}`);
    this.name = 'TransientRunError';
  }
}

/** Control-flow signal: the run was cancelled between windows. */
export class RunCancelledSignal extends Error {
  constructor() {
    super('Run cancelled');
    this.name = 'RunCancelledSignal';
  }
}
