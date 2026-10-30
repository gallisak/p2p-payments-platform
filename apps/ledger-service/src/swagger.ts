import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { INTERNAL_API_KEY_HEADER } from './internal/internal-api-key.guard';

export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('P2P Ledger — ledger-service')
    .setDescription('Wallets, event-sourced ledger, holds, internal and admin API')
    .setVersion('1.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', in: 'header', name: INTERNAL_API_KEY_HEADER }, 'internal-key')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
}
