import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { LocalStorageService } from './local-storage.service';
import { StorageService } from './storage.service';

@Global()
@Module({
  providers: [
    {
      provide: StorageService,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): StorageService =>
        new LocalStorageService(config.storage.localRoot),
    },
  ],
  exports: [StorageService],
})
export class StorageModule {}
