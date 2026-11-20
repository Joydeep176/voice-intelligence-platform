import { Module } from '@nestjs/common';
import { WorkspaceAccessGuard } from '../auth/workspace-access.guard';
import { PlaybackModule } from '../playback/playback.module';
import { RecordingsController } from './recordings.controller';
import { RecordingsRepository } from './recordings.repository';
import { RecordingsService } from './recordings.service';

/** Recordings and upload sessions (API §2). */
@Module({
  imports: [PlaybackModule],
  controllers: [RecordingsController],
  providers: [RecordingsService, RecordingsRepository, WorkspaceAccessGuard],
  exports: [RecordingsRepository],
})
export class RecordingsModule {}
