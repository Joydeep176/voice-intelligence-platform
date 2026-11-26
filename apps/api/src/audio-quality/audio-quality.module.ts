import { Module } from '@nestjs/common';
import { WorkspaceAccessGuard } from '../auth/workspace-access.guard';
import { RunsModule } from '../runs/runs.module';
import { AudioQualityController } from './audio-quality.controller';
import { AudioQualityService } from './audio-quality.service';

/** Phase 3A A1 Audio Quality API (ADR-0044). Queues come from the global QueueModule. */
@Module({
  imports: [RunsModule],
  controllers: [AudioQualityController],
  providers: [AudioQualityService, WorkspaceAccessGuard],
})
export class AudioQualityModule {}
