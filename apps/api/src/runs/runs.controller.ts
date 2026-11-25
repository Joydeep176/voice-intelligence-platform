import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { StartRunBody, type RunSnapshot } from '@vip/contracts';
import type { Response } from 'express';
import { CurrentPrincipal, type Principal } from '../auth/principal';
import { WorkspaceAccessGuard } from '../auth/workspace-access.guard';
import { AppException } from '../common/app-exception';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RunsService } from './runs.service';

const runParam = new ParseUUIDPipe({ exceptionFactory: () => AppException.notFound('Run') });
/** Run snapshot and control (API §3). The snapshot is a database read, never cached. */
@Controller('workspaces/:workspaceId/runs')
@UseGuards(WorkspaceAccessGuard)
export class RunsController {
  constructor(@Inject(RunsService) private readonly runs: RunsService) {}

  @Get(':runId')
  get(
    @Param('workspaceId') workspaceId: string,
    @Param('runId', runParam) runId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RunSnapshot> {
    res.setHeader('Cache-Control', 'no-store');
    return this.runs.get(workspaceId, runId);
  }

  @Post(':runId/cancel')
  @HttpCode(202)
  cancel(
    @Param('workspaceId') workspaceId: string,
    @Param('runId', runParam) runId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RunSnapshot> {
    return this.runs.cancel(workspaceId, runId, principal.id);
  }

  @Post(':runId/retry')
  @HttpCode(202)
  retry(
    @Param('workspaceId') workspaceId: string,
    @Param('runId', runParam) runId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RunSnapshot> {
    return this.runs.retry(workspaceId, runId, principal.id);
  }
}

/** `POST /recordings/{id}/runs`: submit the recording's run (API §3). */
@Controller('workspaces/:workspaceId/recordings/:id/runs')
@UseGuards(WorkspaceAccessGuard)
export class RecordingRunsController {
  constructor(@Inject(RunsService) private readonly runs: RunsService) {}

  @Post()
  @HttpCode(202)
  start(
    @Param('workspaceId') workspaceId: string,
    @Param('id', new ParseUUIDPipe({ exceptionFactory: () => AppException.notFound('Recording') }))
    recordingId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(StartRunBody.default({}))) body: StartRunBody,
  ): Promise<RunSnapshot> {
    return this.runs.start(workspaceId, recordingId, principal.id, body);
  }
}
