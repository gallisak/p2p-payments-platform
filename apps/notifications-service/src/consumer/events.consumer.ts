import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import Redis from 'ioredis';
import { hostname } from 'os';
import { CONSUMER_REDIS } from './redis.provider';
import { ConsumerOptions, consumerOptionsFromEnv } from './consumer-options';
import { Envelope, EventSource, InvalidEnvelopeError, parseEnvelope } from '../events/envelope';
import { effectsOf } from '../events/effects';
import { NotificationsStore } from '../store/notifications.store';
import { NotificationsGateway } from '../gateway/notifications.gateway';
import { eventsProcessed } from '../telemetry/metrics';
import { contextFrom } from '../telemetry/trace-context';

const MAX_BACKOFF_MS = 5_000;
const tracer = trace.getTracer('notifications-service');

type StreamEntry = [id: string, fields: string[]];

function fieldsOf(raw: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let i = 0; i + 1 < raw.length; i += 2) {
    fields[raw[i]] = raw[i + 1];
  }
  return fields;
}

@Injectable()
export class EventsConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(EventsConsumer.name);
  readonly options: ConsumerOptions;
  private readonly sources: Map<string, EventSource>;
  private running = false;
  private loop?: Promise<void>;
  private groupsReady = false;
  private lastReclaim = 0;
  private lastPurge = 0;
  private redisHealthy = true;

  constructor(
    @Inject(CONSUMER_REDIS) private readonly redis: Redis,
    private readonly store: NotificationsStore,
    private readonly gateway: NotificationsGateway,
  ) {
    this.options = consumerOptionsFromEnv(process.env.CONSUMER_NAME || `${hostname()}-${process.pid}`);
    this.sources = new Map(
      (Object.entries(this.options.streams) as [EventSource, string][]).map(([source, stream]) => [
        stream,
        source,
      ]),
    );
    if (this.sources.size !== 2) {
      throw new Error('LEDGER_EVENTS_STREAM and PAYMENTS_EVENTS_STREAM must differ');
    }
    this.redis.on('error', (err: Error) => {
      if (this.redisHealthy) {
        this.redisHealthy = false;
        this.logger.warn(`Lost connection to Redis: ${err.message}`);
      }
    });
    this.redis.on('ready', () => {
      if (!this.redisHealthy) {
        this.logger.log('Reconnected to Redis');
      }
      this.redisHealthy = true;
    });
  }

  onApplicationBootstrap(): void {
    if (process.env.CONSUMER_ENABLED === 'false') {
      return;
    }
    this.running = true;
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    if (this.redis.status !== 'end') {
      this.redis.disconnect();
    }
    await this.loop;
  }

  async ensureGroups(): Promise<void> {
    await this.ensureConnected();
    for (const stream of this.sources.keys()) {
      try {
        await this.redis.xgroup('CREATE', stream, this.options.group, '0', 'MKSTREAM');
      } catch (err) {
        if (!String((err as Error).message).includes('BUSYGROUP')) {
          throw err;
        }
      }
    }
    this.groupsReady = true;
  }

  async pollOnce(blockMs = this.options.blockMs): Promise<number> {
    await this.ensureConnected();
    const streams = [...this.sources.keys()];
    const result = (await this.redis.xreadgroup(
      'GROUP',
      this.options.group,
      this.options.consumer,
      'COUNT',
      this.options.batchSize,
      'BLOCK',
      blockMs,
      'STREAMS',
      ...streams,
      ...streams.map(() => '>'),
    )) as [stream: string, entries: StreamEntry[]][] | null;
    let handled = 0;
    for (const [stream, entries] of result ?? []) {
      for (const [id, raw] of entries) {
        await this.process(stream, id, fieldsOf(raw));
        handled += 1;
      }
    }
    return handled;
  }

  async reclaimOnce(): Promise<number> {
    await this.ensureConnected();
    const storeHealthy = await this.store.ping();
    let handled = 0;
    for (const stream of this.sources.keys()) {
      const pending = (await this.redis.xpending(
        stream,
        this.options.group,
        'IDLE',
        this.options.retryIdleMs,
        '-',
        '+',
        this.options.batchSize,
      )) as [id: string, consumer: string, idleMs: number, deliveries: number][];
      for (const [id, , , deliveries] of pending) {
        if (deliveries >= this.options.maxDeliveries) {
          if (storeHealthy) {
            await this.deadLetterPending(stream, id, deliveries);
          }
          continue;
        }
        const claimed = (await this.redis.xclaim(
          stream,
          this.options.group,
          this.options.consumer,
          this.options.retryIdleMs,
          id,
        )) as (StreamEntry | null)[];
        for (const entry of claimed) {
          if (!entry) {
            continue;
          }
          const [claimedId, raw] = entry;
          await this.process(stream, claimedId, fieldsOf(raw));
          handled += 1;
        }
      }
    }
    return handled;
  }

  private async process(stream: string, id: string, fields: Record<string, string>): Promise<void> {
    const source = this.sources.get(stream) as EventSource;
    let applied;
    try {
      const envelope = parseEnvelope(source, fields.envelope);
      applied = await this.applyTraced(stream, id, source, envelope);
    } catch (err) {
      if (err instanceof InvalidEnvelopeError) {
        await this.deadLetter(stream, id, fields, err.message, 1);
        return;
      }
      eventsProcessed.inc({ source, result: 'retry' });
      this.logger.warn(`Could not process ${stream} ${id}, will retry: ${(err as Error).message}`);
      return;
    }
    await this.redis.xack(stream, this.options.group, id);
    eventsProcessed.inc({ source, result: applied.duplicate ? 'duplicate' : 'applied' });
    if (!applied.duplicate) {
      try {
        this.gateway.publish(applied);
      } catch (err) {
        this.logger.warn(`Could not push ${stream} ${id} to clients: ${(err as Error).message}`);
      }
    }
  }

  private applyTraced(stream: string, id: string, source: EventSource, envelope: Envelope) {
    return tracer.startActiveSpan(
      `consume ${envelope.type}`,
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          'messaging.system': 'redis',
          'messaging.destination.name': stream,
          'messaging.message.id': id,
          'event.id': envelope.eventId,
        },
      },
      contextFrom(envelope.traceparent),
      async (span) => {
        try {
          const applied = await this.store.apply(source, envelope.eventId, effectsOf(source, envelope));
          span.setAttribute('event.duplicate', applied.duplicate);
          return applied;
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }

  private async deadLetterPending(stream: string, id: string, deliveries: number): Promise<void> {
    const entries = (await this.redis.xrange(stream, id, id)) as StreamEntry[];
    const fields = entries.length > 0 ? fieldsOf(entries[0][1]) : {};
    await this.deadLetter(stream, id, fields, `failed after ${deliveries} deliveries`, deliveries);
  }

  private async deadLetter(
    stream: string,
    id: string,
    fields: Record<string, string>,
    reason: string,
    deliveries: number,
  ): Promise<void> {
    await this.redis.xadd(
      this.options.deadLetterStream,
      'MAXLEN',
      '~',
      this.options.deadLetterMaxLen,
      '*',
      'stream',
      stream,
      'id',
      id,
      'reason',
      reason,
      'deliveries',
      String(deliveries),
      'fields',
      JSON.stringify(fields),
    );
    await this.redis.xack(stream, this.options.group, id);
    eventsProcessed.inc({ source: this.sources.get(stream), result: 'dead_lettered' });
    this.logger.error(`Dead-lettered ${stream} ${id}: ${reason}`);
  }

  private async ensureConnected(): Promise<void> {
    if (this.redis.status === 'ready') {
      return;
    }
    if (this.redis.status === 'wait' || this.redis.status === 'end') {
      await this.redis.connect();
      return;
    }
    throw new Error(`Redis is not connected (${this.redis.status})`);
  }

  private async run(): Promise<void> {
    let backoff = 100;
    while (this.running) {
      try {
        if (!this.groupsReady) {
          await this.ensureGroups();
        }
        if (Date.now() - this.lastReclaim >= this.options.reclaimEveryMs) {
          this.lastReclaim = Date.now();
          await this.reclaimOnce();
        }
        if (Date.now() - this.lastPurge >= this.options.purgeEveryMs) {
          this.lastPurge = Date.now();
          await this.store.purgeProcessed(this.options.processedRetentionMs);
        }
        await this.pollOnce();
        backoff = 100;
      } catch (err) {
        if (!this.running) {
          return;
        }
        if (String((err as Error).message).includes('NOGROUP')) {
          this.groupsReady = false;
        }
        this.logger.warn(`Event consumer failed, retrying in ${backoff} ms: ${(err as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, backoff));
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }
}
