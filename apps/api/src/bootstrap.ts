import type { NestExpressApplication } from '@nestjs/platform-express';
import { devHostGuard } from './common/dev-host-guard';
import { ProblemDetailsFilter } from './common/problem-details.filter';
import { requestContext } from './common/request-context';
import type { AppConfig } from './config/app-config';

export const API_PREFIX = 'api/v1';

/** HTTP setup shared by main.ts and the integration tests, so tests exercise the real pipeline. */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  app.disable('x-powered-by');
  app.use(requestContext);
  // Registered before every route, including health and the media route (SEC-01).
  if (config.auth.mode === 'dev') app.use(devHostGuard);
  // JSON only, small bodies. Upload parts are raw application/octet-stream streams and are
  // never parsed or buffered by a body parser.
  app.useBodyParser('json', { limit: '64kb' });
  app.setGlobalPrefix(API_PREFIX);
  app.enableCors({
    origin: config.corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'x-request-id'],
    exposedHeaders: ['x-request-id'],
    maxAge: 600,
  });
  app.useGlobalFilters(new ProblemDetailsFilter());
}
