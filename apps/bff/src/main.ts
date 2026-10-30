import './telemetry/tracing';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setupSwagger } from './swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();
  setupSwagger(app);
  const port = process.env.PORT ?? 3004;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`bff listening on ${port}`);
}
bootstrap();
