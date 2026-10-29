import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { TransfersModule } from './transfers/transfers.module';
import { Transfer } from './transfers/entities/transfer.entity';
import { SagaStep } from './transfers/entities/saga-step.entity';
import { OutboxMessage } from './outbox/outbox-message.entity';

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
      entities: [Transfer, SagaStep, OutboxMessage],
      synchronize: true,
    }),
    AuthModule,
    TransfersModule,
  ],
})
export class AppModule {}
