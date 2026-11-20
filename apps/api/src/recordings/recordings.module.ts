import { Module } from '@nestjs/common';
import { WorkspaceAccessGuard } from '../auth/workspace-access.guard';
import { RecordingsController } from './recordings.controller';
import { RecordingsRepository } from './recordings.repository';
import { RecordingsService } from './recordings.service';

/** Recordings and upload sessions (API §2). */
@Module({
  controllers: [RecordingsController],
  providers: [RecordingsService, RecordingsRepository, WorkspaceAccessGuard],
  exports: [RecordingsRepository],
})
export class RecordingsModule {}
