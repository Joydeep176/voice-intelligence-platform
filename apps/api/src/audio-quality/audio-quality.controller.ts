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
import type { AudioDiagnosticsSnapshot } from '@vip/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentPrincipal, type Principal } from '../auth/principal';
import { WorkspaceAccessGuard } from '../auth/workspace-access.guard';
import { AppException } from '../common/app-exception';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AudioQualityService } from './audio-quality.service';

const runParam = new ParseUUIDPipe({ exceptionFactory: () => AppException.notFound('Run') });
const RangeQuery = z
  .object({
    fromMs: z.coerce.number().int().min(0).optional(),
    toMs: z.coerce.number().int().min(1).optional(),
  })
  .strict()
  .refine((q) => q.fromMs === undefined || q.toMs === undefined || q.fromMs < q.toMs, {
    message: 'fromMs must be below toMs',
  });

/** Audio diagnostics (API §4): the A1 Audio Quality Agent's output, separate from uncertainty. */
@Controller('workspaces/:workspaceId/runs/:runId/audio-diagnostics')
@UseGuards(WorkspaceAccessGuard)
export class AudioQualityController {
  constructor(@Inject(AudioQualityService) private readonly service: AudioQualityService) {}

  @Get()
  get(
    @Param('workspaceId') workspaceId: string,
    @Param('runId', runParam) runId: string,
    @Query(new ZodValidationPipe(RangeQuery)) query: z.infer<typeof RangeQuery>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AudioDiagnosticsSnapshot> {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.get(workspaceId, runId, query);
  }

  @Post('retry')
  @HttpCode(202)
  retry(
    @Param('workspaceId') workspaceId: string,
    @Param('runId', runParam) runId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AudioDiagnosticsSnapshot> {
    return this.service.retry(workspaceId, runId, principal.id);
  }
}
