import { Context, ROOT_CONTEXT, context, propagation } from '@opentelemetry/api';

const TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

export function currentTraceparent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
}

export function contextFrom(traceparent: unknown): Context {
  return typeof traceparent === 'string' && TRACEPARENT.test(traceparent)
    ? propagation.extract(ROOT_CONTEXT, { traceparent })
    : ROOT_CONTEXT;
}
