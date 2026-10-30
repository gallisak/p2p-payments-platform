import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NOTIFICATIONS_ENTITIES, NotificationsModule } from './notifications.module';
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
      entities: NOTIFICATIONS_ENTITIES,
      synchronize: true,
    }),
    NotificationsModule,
  ],
  controllers: [MetricsController],
})
export class AppModule {}
