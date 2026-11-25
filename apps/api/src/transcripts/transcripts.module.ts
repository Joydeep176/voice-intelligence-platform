import { Module } from '@nestjs/common';
import { WorkspaceAccessGuard } from '../auth/workspace-access.guard';
import { RunsModule } from '../runs/runs.module';
import { TranscriptsController } from './transcripts.controller';
import { TranscriptsService } from './transcripts.service';

/** Transcript, uncertainty, raw-output metadata and speaker endpoints (API §5). */
@Module({
  imports: [RunsModule],
  controllers: [TranscriptsController],
  providers: [TranscriptsService, WorkspaceAccessGuard],
})
export class TranscriptsModule {}
