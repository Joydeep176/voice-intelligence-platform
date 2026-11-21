import { Controller, Get, Headers, Inject, Logger, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { pipeline } from 'node:stream';
import { AppException } from '../common/app-exception';
import { ObjectNotFoundError, StorageService } from '../storage/storage.service';
import { parseRange } from './range';
import { PlaybackService } from './playback.service';

const SECURITY_HEADERS = {
  'Accept-Ranges': 'bytes',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'private, no-store',
  'Content-Disposition': 'inline',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
};

/**
 * Streams a recording for a signed playback URL (ADR-0033). No workspace guard: the token is
 * the capability and is re-validated against the database on every request. Every failure is
 * the same 404. Media requests are not audited. The token is never logged: request logs use
 * the route pattern, and nothing here logs request data.
 */
@Controller('media/recordings')
export class MediaController {
  private readonly logger = new Logger(MediaController.name);

  constructor(
    @Inject(PlaybackService) private readonly playback: PlaybackService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  @Get(':token')
  async stream(
    @Param('token') token: string,
    @Headers('range') rangeHeader: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    const media = await this.playback.resolve(token, (recordingId, code) =>
      this.logger.warn({ msg: 'playback_integrity_failure', code, recordingId }),
    );
    if (!media) throw AppException.notFound('Recording');

    let size: number;
    try {
      size = (await this.storage.statObject(media.key)).sizeBytes;
    } catch (error) {
      this.logger.warn({
        msg: 'playback_integrity_failure',
        code: error instanceof ObjectNotFoundError ? 'OBJECT_MISSING' : 'STORAGE_READ_FAILED',
        recordingId: media.recording.id,
      });
      throw AppException.notFound('Recording');
    }

    const range = parseRange(rangeHeader, size);
    res.setHeader('Content-Type', media.recording.mimeType);
    if (range.kind === 'unsatisfiable') {
      res.status(416).setHeader('Content-Range', `bytes */${size}`);
      res.setHeader('Content-Length', '0');
      res.end();
      return;
    }
    if (range.kind === 'partial') {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      res.setHeader('Content-Length', String(range.end - range.start + 1));
    } else {
      res.status(200);
      res.setHeader('Content-Length', String(size));
    }
    if (size === 0) {
      res.end();
      return;
    }

    let source;
    try {
      source = await this.storage.openReadStream(
        media.key,
        range.kind === 'partial' ? { start: range.start, end: range.end } : undefined,
      );
    } catch {
      this.logger.warn({
        msg: 'playback_integrity_failure',
        code: 'OBJECT_MISSING',
        recordingId: media.recording.id,
      });
      res.removeHeader('Content-Range');
      res.removeHeader('Content-Length');
      res.removeHeader('Content-Type');
      throw AppException.notFound('Recording');
    }
    res.on('close', () => source.destroy());
    const recordingId = media.recording.id;
    pipeline(source, res, (err) => {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      // A client disconnect is not a failure. Never log the token, path or content.
      const disconnect =
        code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECONNRESET' || code === 'EPIPE';
      if (err && !disconnect) {
        this.logger.warn({ msg: 'playback_stream_failed', code: code ?? 'UNKNOWN', recordingId });
      }
    });
  }
}
