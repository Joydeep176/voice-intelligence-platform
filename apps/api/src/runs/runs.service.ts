import { Inject, Injectable } from '@nestjs/common';
import type { ProcessingStatus } from '@vip/contracts';
import { AppException } from '../common/app-exception';
import { toProcessingStatus } from '../recordings/recording.mapper';
import { RecordingsRepository } from '../recordings/recordings.repository';

/** Processing-status reads. Run start/cancel/retry arrive with the pipeline (later phase). */
@Injectable()
export class RunsService {
  constructor(@Inject(RecordingsRepository) private readonly repo: RecordingsRepository) {}

  async get(workspaceId: string, runId: string): Promise<ProcessingStatus> {
    const run = await this.repo.findRun(workspaceId, runId);
    if (!run) throw AppException.notFound('Run');
    return toProcessingStatus(run);
  }
}
