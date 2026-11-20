import { Module } from '@nestjs/common';
import { RecordingsRepository } from '../recordings/recordings.repository';
import { MediaController } from './media.controller';
import { PlaybackService } from './playback.service';

/** Signed local playback (ADR-0033). Config, storage, audit and DB come from global modules. */
@Module({
  controllers: [MediaController],
  providers: [PlaybackService, RecordingsRepository],
  exports: [PlaybackService],
})
export class PlaybackModule {}
