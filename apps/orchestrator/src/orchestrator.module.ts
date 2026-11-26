import { type DynamicModule, Module } from '@nestjs/common';
import { ORCHESTRATOR_CONFIG, type OrchestratorConfig } from './config';
import {
  FOUNDATION_PROCESSOR,
  FoundationCheckWorker,
  type FoundationProcessor,
  defaultFoundationProcessor,
} from './foundation-check.worker';
import { AUDIO_TASKS_OVERRIDE, ProcessingWorkers } from './processing/processing.workers';
import type { AudioTasks } from './processing/audio-client';
import type { RawStore } from './providers/raw-store';
import type { ResolvedProviders } from './providers/registry';
import { RUN_PROVIDERS_OVERRIDE, RunWorkers } from './runs/run.workers';
import { AudioQualityWorkers } from './agents/audio-quality/audio-quality.workers';

/**
 * Foundation check worker, the Phase 2B audio processing coordinator and the Phase 2C
 * transcription run coordinator (D-2C-01) and the Phase 3A A1 Audio Quality worker (ADR-0044).
 * LangGraph remains the shared orchestration target (OD-04b); it arrives with Phase 3B.
 */
@Module({})
export class OrchestratorModule {
  static forRoot(
    config: OrchestratorConfig,
    processor: FoundationProcessor = defaultFoundationProcessor,
    audioTasks?: AudioTasks,
    runProviders?: (store: RawStore) => ResolvedProviders,
  ): DynamicModule {
    return {
      module: OrchestratorModule,
      providers: [
        { provide: ORCHESTRATOR_CONFIG, useValue: config },
        { provide: FOUNDATION_PROCESSOR, useValue: processor },
        ...(audioTasks ? [{ provide: AUDIO_TASKS_OVERRIDE, useValue: audioTasks }] : []),
        ...(runProviders ? [{ provide: RUN_PROVIDERS_OVERRIDE, useValue: runProviders }] : []),
        FoundationCheckWorker,
        ProcessingWorkers,
        RunWorkers,
        AudioQualityWorkers,
      ],
      exports: [FoundationCheckWorker, ProcessingWorkers, RunWorkers, AudioQualityWorkers],
    };
  }
}
