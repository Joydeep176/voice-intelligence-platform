import { Module } from '@nestjs/common';
import { WorkspaceAccessGuard } from '../auth/workspace-access.guard';
import { RecordingsModule } from '../recordings/recordings.module';
import { RunAudit } from './run-audit';
import { RecordingRunsController, RunsController } from './runs.controller';
import { RunsService } from './runs.service';

/** Run snapshots and control. Queues come from the global QueueModule. */
@Module({
  imports: [RecordingsModule],
  controllers: [RunsController, RecordingRunsController],
  providers: [RunsService, RunAudit, WorkspaceAccessGuard],
  exports: [RunAudit],
})
export class RunsModule {}
