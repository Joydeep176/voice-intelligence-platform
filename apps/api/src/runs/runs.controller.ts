import { Controller, Get, Inject, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import type { ProcessingStatus } from '@vip/contracts';
import { WorkspaceAccessGuard } from '../auth/workspace-access.guard';
import { AppException } from '../common/app-exception';
import { RunsService } from './runs.service';

/** Run status snapshot (API §3 `GET /runs/{runId}`, FR-11.1). Start/cancel/retry: later phase. */
@Controller('workspaces/:workspaceId/runs')
@UseGuards(WorkspaceAccessGuard)
export class RunsController {
  constructor(@Inject(RunsService) private readonly runs: RunsService) {}

  @Get(':runId')
  get(
    @Param('workspaceId') workspaceId: string,
    @Param('runId', new ParseUUIDPipe({ exceptionFactory: () => AppException.notFound('Run') }))
    runId: string,
  ): Promise<ProcessingStatus> {
    return this.runs.get(workspaceId, runId);
  }
}
