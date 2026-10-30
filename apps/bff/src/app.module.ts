import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { ActivityController } from './api/activity.controller';
import { AdminController } from './api/admin.controller';
import { AuthController } from './api/auth.controller';
import { DashboardController } from './api/dashboard.controller';
import { HealthController } from './api/health.controller';
import { SplitBillsController } from './api/split-bills.controller';
import { TransfersController } from './api/transfers.controller';
import { WalletsController } from './api/wallets.controller';
import { UpstreamClient } from './upstream/upstream.client';
import { UpstreamUnavailableFilter } from './upstream/upstream-unavailable.filter';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [
    HealthController,
    AuthController,
    DashboardController,
    WalletsController,
    TransfersController,
    SplitBillsController,
    ActivityController,
    AdminController,
  ],
  providers: [UpstreamClient, { provide: APP_FILTER, useClass: UpstreamUnavailableFilter }],
})
export class AppModule {}
