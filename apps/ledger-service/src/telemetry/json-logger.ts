import { LoggerService } from '@nestjs/common';
import { trace } from '@opentelemetry/api';

const SERVICE = process.env.OTEL_SERVICE_NAME ?? 'ledger-service';

type Level = 'error' | 'warn' | 'info' | 'debug' | 'verbose' | 'fatal';

export function writeLog(level: Level, context: string | undefined, message: unknown, extra: object = {}): void {
  const span = trace.getActiveSpan()?.spanContext();
  const entry = {
    time: new Date().toISOString(),
    level,
    service: SERVICE,
    context,
    message: typeof message === 'string' ? message : JSON.stringify(message),
    traceId: span?.traceId,
    spanId: span?.spanId,
    ...extra,
  };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

function contextOf(params: unknown[]): string | undefined {
  const last = params[params.length - 1];
  return typeof last === 'string' ? last : undefined;
}

export class JsonLogger implements LoggerService {
  log(message: unknown, ...params: unknown[]): void {
    writeLog('info', contextOf(params), message);
  }

  error(message: unknown, ...params: unknown[]): void {
    const stack = params.length > 1 ? params[0] : undefined;
    writeLog('error', contextOf(params), message, typeof stack === 'string' ? { stack } : {});
  }

  warn(message: unknown, ...params: unknown[]): void {
    writeLog('warn', contextOf(params), message);
  }

  debug(message: unknown, ...params: unknown[]): void {
    writeLog('debug', contextOf(params), message);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    writeLog('verbose', contextOf(params), message);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    writeLog('fatal', contextOf(params), message);
  }
}
