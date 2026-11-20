import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { HealthResponse, ProbeResponse } from '@vip/contracts';
import type { Response } from 'express';
import { HealthService } from './health.service';

/** Unauthenticated probes outside the workspace prefix (API §8). */
@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  /** Application health plus dependency status. 503 only when a required dependency is down. */
  @Get()
  async full(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
    const report = await this.health.full();
    if (report.status === 'down') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }

  @Get('live')
  live(): ProbeResponse {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ProbeResponse> {
    const status = await this.health.readiness();
    if (status !== 'ok') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return { status };
  }
}
