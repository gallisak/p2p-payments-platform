import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxMessage } from './outbox-message.entity';
import { OutboxWriter } from './outbox.writer';
import { OutboxRelay } from './outbox-relay.service';
import { OUTBOX_REDIS, createRedis, requireRedisUrl } from './redis.provider';

@Module({
  imports: [TypeOrmModule.forFeature([OutboxMessage])],
  providers: [
    OutboxWriter,
    OutboxRelay,
    { provide: OUTBOX_REDIS, useFactory: () => createRedis(requireRedisUrl()) },
  ],
  exports: [OutboxWriter],
})
export class OutboxModule {}
