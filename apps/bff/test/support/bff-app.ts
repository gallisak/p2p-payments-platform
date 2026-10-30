import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { setupSwagger } from '../../src/swagger';
import { FakeUpstream } from './fake-upstream';

export interface BffApp {
  app: INestApplication;
  ledger: FakeUpstream;
  payments: FakeUpstream;
  notifications: FakeUpstream;
  http: () => ReturnType<typeof request>;
  reset: () => void;
  close: () => Promise<void>;
}

export async function createBffApp(): Promise<BffApp> {
  const ledger = new FakeUpstream();
  const payments = new FakeUpstream();
  const notifications = new FakeUpstream();
  process.env.LEDGER_SERVICE_URL = await ledger.start();
  process.env.PAYMENTS_SERVICE_URL = await payments.start();
  process.env.NOTIFICATIONS_SERVICE_URL = await notifications.start();
  process.env.UPSTREAM_TIMEOUT_MS = '300';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  setupSwagger(app);
  await app.init();
  return {
    app,
    ledger,
    payments,
    notifications,
    http: () => request(app.getHttpServer()),
    reset: () => [ledger, payments, notifications].forEach((u) => u.reset()),
    close: async () => {
      await app.close();
      await Promise.all([ledger.stop(), payments.stop(), notifications.stop()]);
    },
  };
}
