import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import type { AppConfig } from '../config/app-config';

const LEVELS: Record<AppConfig['logLevel'], LogLevel[]> = {
  fatal: ['fatal'],
  error: ['fatal', 'error'],
  warn: ['fatal', 'error', 'warn'],
  info: ['fatal', 'error', 'warn', 'log'],
  debug: ['fatal', 'error', 'warn', 'log', 'debug'],
  verbose: ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'],
};

/** Structured JSON logs (OD-15 tooling remains Open; no tracing exporter). */
export function createLogger(level: AppConfig['logLevel']): ConsoleLogger {
  return new ConsoleLogger({ json: true, logLevels: LEVELS[level] });
}
