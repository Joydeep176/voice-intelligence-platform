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

/**
 * Foundation check worker, the Phase 2B audio processing coordinator and the Phase 2C
 * transcription run coordinator (D-2C-01). Agents and LangGraph arrive in later phases.
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
      ],
      exports: [FoundationCheckWorker, ProcessingWorkers, RunWorkers],
    };
  }
}
