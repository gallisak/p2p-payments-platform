import './telemetry/tracing';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { setupSwagger } from './swagger';
import { corsOrigin } from './common/cors';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors({ origin: corsOrigin });
  app.enableShutdownHooks();
  setupSwagger(app);
  const port = process.env.PORT ?? 3003;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`notifications-service listening on ${port}`);
}
bootstrap();
