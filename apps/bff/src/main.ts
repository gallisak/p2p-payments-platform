import './telemetry/tracing';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setupSwagger } from './swagger';
import { httpTelemetry } from './telemetry/http-telemetry';
import { JsonLogger } from './telemetry/json-logger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: new JsonLogger() });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();
  app.use(httpTelemetry);
  setupSwagger(app);
  const port = process.env.PORT ?? 3004;
  await app.listen(port);
  new Logger('Bootstrap').log(`bff listening on ${port}`);
}
bootstrap();
