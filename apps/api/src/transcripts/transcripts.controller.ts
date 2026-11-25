import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  SpeakerPatch,
  TranscriptQuery,
  type RawOutputList,
  type SpeakerDto,
  type SpeakerList,
  type TranscriptPage,
  type TranscriptVersionList,
  type UncertaintyList,
} from '@vip/contracts';
import type { Response } from 'express';
import { CurrentPrincipal, type Principal } from '../auth/principal';
import { WorkspaceAccessGuard } from '../auth/workspace-access.guard';
import { AppException } from '../common/app-exception';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { TranscriptsService } from './transcripts.service';

const runParam = new ParseUUIDPipe({ exceptionFactory: () => AppException.notFound('Run') });
/**
 * Transcript read endpoints and speaker rename (API §5). Correction versions
 * (`POST .../versions`) and derivations are not implemented: those routes do not exist.
 * Transcript content is never cached.
 */
@Controller('workspaces/:workspaceId/runs/:runId')
@UseGuards(WorkspaceAccessGuard)
export class TranscriptsController {
  constructor(@Inject(TranscriptsService) private readonly transcripts: TranscriptsService) {}

  @Get('transcript/versions')
  versions(
    @Param('workspaceId') workspaceId: string,
    @Param('runId', runParam) runId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TranscriptVersionList> {
    res.setHeader('Cache-Control', 'no-store');
    return this.transcripts.versions(workspaceId, runId);
  }

  @Get('transcript/uncertainties')
  uncertainties(
    @Param('workspaceId') workspaceId: string,
    @Param('runId', runParam) runId: string,
    @Query(new ZodValidationPipe(TranscriptQuery)) query: TranscriptQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UncertaintyList> {
    res.setHeader('Cache-Control', 'no-store');
    return this.transcripts.uncertainties(workspaceId, runId, query);
  }

  @Get('transcript/raw')
  raw(
    @Param('workspaceId') workspaceId: string,
    @Param('runId', runParam) runId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RawOutputList> {
    res.setHeader('Cache-Control', 'no-store');
    return this.transcripts.raw(workspaceId, runId);
  }

  @Get('transcript')
  segments(
    @Param('workspaceId') workspaceId: string,
    @Param('runId', runParam) runId: string,
    @Query(new ZodValidationPipe(TranscriptQuery)) query: TranscriptQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TranscriptPage> {
    res.setHeader('Cache-Control', 'no-store');
    return this.transcripts.segments(workspaceId, runId, query);
  }

  @Get('speakers')
  speakers(
    @Param('workspaceId') workspaceId: string,
    @Param('runId', runParam) runId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SpeakerList> {
    res.setHeader('Cache-Control', 'no-store');
    return this.transcripts.speakers(workspaceId, runId);
  }

  @Patch('speakers/:speakerId')
  renameSpeaker(
    @Param('workspaceId') workspaceId: string,
    @Param('runId', runParam) runId: string,
    @Param(
      'speakerId',
      new ParseUUIDPipe({ exceptionFactory: () => AppException.notFound('Speaker') }),
    )
    speakerId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(SpeakerPatch)) body: SpeakerPatch,
  ): Promise<SpeakerDto> {
    return this.transcripts.renameSpeaker(workspaceId, runId, speakerId, principal.id, body);
  }
}
