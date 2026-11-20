import { Module } from '@nestjs/common';
import { AudioServiceClient } from './audio-service.client';

@Module({ providers: [AudioServiceClient], exports: [AudioServiceClient] })
export class AudioServiceModule {}
