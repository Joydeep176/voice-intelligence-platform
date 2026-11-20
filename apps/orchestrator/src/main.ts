import 'reflect-metadata';
import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigError, loadConfig, type OrchestratorConfig } from './config';
import { OrchestratorModule } from './orchestrator.module';

const LEVELS: Record<OrchestratorConfig['logLevel'], LogLevel[]> = {
  fatal: ['fatal'],
  error: ['fatal', 'error'],
  warn: ['fatal', 'error', 'warn'],
  info: ['fatal', 'error', 'warn', 'log'],
  debug: ['fatal', 'error', 'warn', 'log', 'debug'],
  verbose: ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'],
};

async function main(): Promise<void> {
  let config: OrchestratorConfig;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
  const app = await NestFactory.createApplicationContext(OrchestratorModule.forRoot(config), {
    logger: new ConsoleLogger({ json: true, logLevels: LEVELS[config.logLevel] }),
  });
  app.enableShutdownHooks(['SIGINT', 'SIGTERM']);
  await app.init();
}

void main();
