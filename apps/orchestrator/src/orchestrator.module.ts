import { type DynamicModule, Module } from '@nestjs/common';
import { ORCHESTRATOR_CONFIG, type OrchestratorConfig } from './config';
import {
  FOUNDATION_PROCESSOR,
  FoundationCheckWorker,
  type FoundationProcessor,
  defaultFoundationProcessor,
} from './foundation-check.worker';

/** Phase 1: only the foundation check worker. Agents and LangGraph arrive in later phases. */
@Module({})
export class OrchestratorModule {
  static forRoot(
    config: OrchestratorConfig,
    processor: FoundationProcessor = defaultFoundationProcessor,
  ): DynamicModule {
    return {
      module: OrchestratorModule,
      providers: [
        { provide: ORCHESTRATOR_CONFIG, useValue: config },
        { provide: FOUNDATION_PROCESSOR, useValue: processor },
        FoundationCheckWorker,
      ],
      exports: [FoundationCheckWorker],
    };
  }
}
