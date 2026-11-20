import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  CreateRecordingRequest,
  PaginationQuery,
  type RecordingList,
  type RecordingMetadata,
  type RecordingUploadResponse,
  type UploadPartResponse,
  type UploadSession,
} from '@vip/contracts';
import type { Request } from 'express';
import { CurrentPrincipal, type Principal } from '../auth/principal';
import { WorkspaceAccessGuard } from '../auth/workspace-access.guard';
import { AppException } from '../common/app-exception';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RecordingsService } from './recordings.service';

const uuidParam = new ParseUUIDPipe({ exceptionFactory: () => AppException.notFound('Recording') });

/** Consent is checked first so a missing attestation gets its specific code (API §2). */
class ConsentFirstPipe extends ZodValidationPipe<typeof CreateRecordingRequest> {
  constructor() {
    super(CreateRecordingRequest);
  }

  override transform(value: unknown): CreateRecordingRequest {
    const consent = (value as { consent?: { attested?: unknown } } | null)?.consent;
    if (consent?.attested !== true) {
      throw new AppException(
        422,
        'CONSENT_REQUIRED',
        'Consent attestation required',
        'Uploads require a consent attestation (SEC-1).',
      );
    }
    return super.transform(value);
  }
}

/**
 * Workspace-scoped recording routes (API §2). HTTP concerns only: validation and mapping.
 * Business rules live in RecordingsService.
 */
@Controller('workspaces/:workspaceId/recordings')
@UseGuards(WorkspaceAccessGuard)
export class RecordingsController {
  constructor(@Inject(RecordingsService) private readonly recordings: RecordingsService) {}

  @Post()
  @HttpCode(201)
  create(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId') workspaceId: string,
    @Body(new ConsentFirstPipe()) body: CreateRecordingRequest,
  ): Promise<RecordingUploadResponse> {
    return this.recordings.create(principal, workspaceId, body);
  }

  @Get()
  list(
    @Param('workspaceId') workspaceId: string,
    @Query(new ZodValidationPipe(PaginationQuery)) query: PaginationQuery,
  ): Promise<RecordingList> {
    return this.recordings.list(workspaceId, query.limit, query.cursor);
  }

  @Get(':id')
  get(
    @Param('workspaceId') workspaceId: string,
    @Param('id', uuidParam) id: string,
  ): Promise<RecordingMetadata> {
    return this.recordings.get(workspaceId, id);
  }

  @Get(':id/upload')
  uploadSession(
    @Param('workspaceId') workspaceId: string,
    @Param('id', uuidParam) id: string,
  ): Promise<UploadSession> {
    return this.recordings.getUploadSession(workspaceId, id);
  }

  /** Local chunked upload (development strategy). The request body is streamed, not buffered. */
  @Put(':id/upload/parts/:partNumber')
  uploadPart(
    @Param('workspaceId') workspaceId: string,
    @Param('id', uuidParam) id: string,
    @Param(
      'partNumber',
      new ParseIntPipe({
        exceptionFactory: () => new AppException(422, 'UPLOAD_PART_INVALID', 'Invalid part number'),
      }),
    )
    partNumber: number,
    @Req() req: Request,
  ): Promise<UploadPartResponse> {
    if (!req.is('application/octet-stream')) {
      throw new AppException(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'Unsupported media type',
        'Parts must be sent as application/octet-stream.',
      );
    }
    const header = req.header('content-length');
    const declared = header === undefined ? undefined : Number(header);
    return this.recordings.uploadPart(
      workspaceId,
      id,
      partNumber,
      req,
      Number.isFinite(declared) ? declared : undefined,
    );
  }

  @Post(':id/upload/complete')
  @HttpCode(200)
  complete(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId') workspaceId: string,
    @Param('id', uuidParam) id: string,
  ): Promise<RecordingMetadata> {
    return this.recordings.complete(principal, workspaceId, id);
  }
}
