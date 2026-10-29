import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityController } from './activity/activity.controller';
import { JwtStrategy } from './auth/jwt.strategy';
import { NotificationsGateway } from './gateway/notifications.gateway';
import { HealthController } from './health.controller';
import { Activity } from './store/entities/activity.entity';
import { ProcessedEvent } from './store/entities/processed-event.entity';
import { TransferSnapshot } from './store/entities/transfer-snapshot.entity';
import { WalletSnapshot } from './store/entities/wallet-snapshot.entity';
import { NotificationsStore } from './store/notifications.store';

export const NOTIFICATIONS_ENTITIES = [ProcessedEvent, WalletSnapshot, TransferSnapshot, Activity];

@Module({
  imports: [
    TypeOrmModule.forFeature(NOTIFICATIONS_ENTITIES),
    PassportModule,
    JwtModule.register({}),
  ],
  controllers: [HealthController, ActivityController],
  providers: [JwtStrategy, NotificationsStore, NotificationsGateway],
})
export class NotificationsModule {}
