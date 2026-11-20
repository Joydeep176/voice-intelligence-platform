import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, type Database, type DbHandle } from '@vip/db';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

export const DB_HANDLE = Symbol('DB_HANDLE');
export const DB = Symbol('DB');

@Injectable()
class DbLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  async onApplicationShutdown(): Promise<void> {
    await this.handle.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DB_HANDLE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): DbHandle =>
        createDb(config.database.url, { maxConnections: config.database.poolMax }),
    },
    { provide: DB, inject: [DB_HANDLE], useFactory: (h: DbHandle): Database => h.db },
    DbLifecycle,
  ],
  exports: [DB, DB_HANDLE],
})
export class DatabaseModule {}
