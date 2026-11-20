import { Module } from '@nestjs/common';
import { WorkspaceAccessGuard } from '../auth/workspace-access.guard';
import { RecordingsModule } from '../recordings/recordings.module';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';

/** Processing status (run snapshots). */
@Module({
  imports: [RecordingsModule],
  controllers: [RunsController],
  providers: [RunsService, WorkspaceAccessGuard],
})
export class RunsModule {}
