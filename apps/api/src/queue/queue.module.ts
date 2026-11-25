import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { AudioQueues } from './audio-queues.producer';
import { FoundationCheckProducer } from './foundation-check.producer';
import { RunQueues } from './run-queues.producer';
import { RUN_SETTINGS, loadRunSettings, type RunSettings } from './run-settings';

@Injectable()
class QueueLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(FoundationCheckProducer) private readonly producer: FoundationCheckProducer,
    @Inject(AudioQueues) private readonly audioQueues: AudioQueues,
    @Inject(RunQueues) private readonly runQueues: RunQueues,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.producer.close(), this.audioQueues.close(), this.runQueues.close()]);
  }
}

/** BullMQ producers owned by NestJS (ADR-0002). Workers live in apps/orchestrator. */
@Global()
@Module({
  providers: [
    {
      provide: FoundationCheckProducer,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new FoundationCheckProducer(config),
    },
    {
      provide: AudioQueues,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new AudioQueues(config),
    },
    { provide: RUN_SETTINGS, useFactory: (): RunSettings => loadRunSettings() },
    {
      provide: RunQueues,
      inject: [APP_CONFIG, RUN_SETTINGS],
      useFactory: (config: AppConfig, settings: RunSettings) => new RunQueues(config, settings),
    },
    QueueLifecycle,
  ],
  exports: [FoundationCheckProducer, AudioQueues, RunQueues, RUN_SETTINGS],
})
export class QueueModule {}
