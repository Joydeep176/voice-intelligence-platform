import { Module } from '@nestjs/common';
import { AudioServiceModule } from '../audio-service/audio-service.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [AudioServiceModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
