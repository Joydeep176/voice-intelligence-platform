import { Module } from '@nestjs/common';
import { AudioServiceModule } from '../audio-service/audio-service.module';
import { WorkspaceAccessGuard } from '../auth/workspace-access.guard';
import { RecordingsModule } from '../recordings/recordings.module';
import { ProcessingController } from './processing.controller';
import { ProcessingRepository } from './processing.repository';
import { ProcessingService } from './processing.service';

/** Explicit audio processing endpoints (Phase 2B WS7). Queues come from the global QueueModule. */
@Module({
  imports: [RecordingsModule, AudioServiceModule],
  controllers: [ProcessingController],
  providers: [ProcessingService, ProcessingRepository, WorkspaceAccessGuard],
})
export class ProcessingModule {}
