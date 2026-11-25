import { type DynamicModule, Global, Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.module';
import { APP_CONFIG, type AppConfig } from './config/app-config';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { ProcessingModule } from './processing/processing.module';
import { QueueModule } from './queue/queue.module';
import { RecordingsModule } from './recordings/recordings.module';
import { RunsModule } from './runs/runs.module';
import { StorageModule } from './storage/storage.module';
import { TranscriptsModule } from './transcripts/transcripts.module';

@Global()
@Module({})
class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}

/** Root module. Config is validated before the module is built (see main.ts). */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        DatabaseModule,
        StorageModule,
        QueueModule,
        AuditModule,
        HealthModule,
        RecordingsModule,
        ProcessingModule,
        RunsModule,
        TranscriptsModule,
      ],
    };
  }
}
