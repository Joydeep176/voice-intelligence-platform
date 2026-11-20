import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { FoundationCheckProducer } from './foundation-check.producer';

@Injectable()
class QueueLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(FoundationCheckProducer) private readonly producer: FoundationCheckProducer,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.producer.close();
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
    QueueLifecycle,
  ],
  exports: [FoundationCheckProducer],
})
export class QueueModule {}
