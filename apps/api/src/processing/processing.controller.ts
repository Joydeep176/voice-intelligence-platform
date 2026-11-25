import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ProcessingSegmentsQuery,
  type ProcessingSegmentList,
  type ProcessingSnapshot,
} from '@vip/contracts';
import type { Response } from 'express';
import { WorkspaceAccessGuard } from '../auth/workspace-access.guard';
import { AppException } from '../common/app-exception';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ProcessingService } from './processing.service';

const uuidParam = new ParseUUIDPipe({ exceptionFactory: () => AppException.notFound('Recording') });

/**
 * Workspace-scoped audio processing routes (API §3a). `GET` is a database snapshot; start and
 * cancel only record the request. Snapshots are never cached.
 */
@Controller('workspaces/:workspaceId/recordings/:id/processing')
@UseGuards(WorkspaceAccessGuard)
export class ProcessingController {
  constructor(@Inject(ProcessingService) private readonly processing: ProcessingService) {}

  @Get()
  get(
    @Param('workspaceId') workspaceId: string,
    @Param('id', uuidParam) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProcessingSnapshot> {
    res.setHeader('Cache-Control', 'no-store');
    return this.processing.snapshot(workspaceId, id);
  }

  @Get('segments')
  segments(
    @Param('workspaceId') workspaceId: string,
    @Param('id', uuidParam) id: string,
    @Query(new ZodValidationPipe(ProcessingSegmentsQuery)) query: ProcessingSegmentsQuery,
  ): Promise<ProcessingSegmentList> {
    return this.processing.segments(workspaceId, id, query);
  }

  /** `202` when work was queued or is in flight, `200` when the result already exists. */
  @Post()
  async start(
    @Param('workspaceId') workspaceId: string,
    @Param('id', uuidParam) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProcessingSnapshot> {
    const result = await this.processing.start(workspaceId, id);
    res.status(result.httpStatus);
    return result.snapshot;
  }

  @Post('cancel')
  @HttpCode(202)
  cancel(
    @Param('workspaceId') workspaceId: string,
    @Param('id', uuidParam) id: string,
  ): Promise<ProcessingSnapshot> {
    return this.processing.cancel(workspaceId, id);
  }
}
