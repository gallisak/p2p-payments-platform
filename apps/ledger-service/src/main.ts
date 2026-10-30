import './telemetry/tracing';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { setupSwagger } from './swagger';
import { httpTelemetry } from './telemetry/http-telemetry';
import { JsonLogger } from './telemetry/json-logger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: new JsonLogger() });
  app.enableShutdownHooks();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.use(httpTelemetry);
  setupSwagger(app);
  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  new Logger('Bootstrap').log(`ledger-service listening on ${port}`);
}
bootstrap();
