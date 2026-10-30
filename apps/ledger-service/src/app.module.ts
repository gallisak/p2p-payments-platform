import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { EmailNormalizationModule } from './auth/email-normalization.module';
import { WalletsModule } from './wallets/wallets.module';
import { InternalModule } from './internal/internal.module';
import { AdminModule } from './admin/admin.module';
import { User } from './auth/entities/user.entity';
import { Wallet } from './wallets/entities/wallet.entity';
import { Hold } from './wallets/entities/hold.entity';
import { LedgerEvent } from './ledger/entities/ledger-event.entity';
import { LedgerEntry } from './ledger/entities/ledger-entry.entity';
import { OutboxMessage } from './outbox/outbox-message.entity';
import { MetricsController } from './telemetry/metrics.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT ?? 5432),
      username: process.env.DATABASE_USER,
      password: process.env.DATABASE_PASSWORD,
      database: process.env.DATABASE_NAME,
      entities: [User, Wallet, Hold, LedgerEvent, LedgerEntry, OutboxMessage],
      synchronize: true, // OK для стартового репо; у бойовому коді — міграції
    }),
    AuthModule,
    EmailNormalizationModule,
    WalletsModule,
    InternalModule,
    AdminModule,
  ],
  controllers: [MetricsController],
})
export class AppModule {}
