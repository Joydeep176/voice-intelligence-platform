import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { ConfigError, loadConfig } from './config/app-config';
import { createLogger } from './common/logger';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    logger: createLogger(config.logLevel),
    bodyParser: false,
  });
  configureApp(app, config);
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
  new Logger('Bootstrap').log({
    msg: 'api_started',
    port: config.port,
    environment: config.env,
    authMode: config.auth.mode,
  });
}

void main();
