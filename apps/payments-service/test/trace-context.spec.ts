import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { node } from '@opentelemetry/sdk-node';
import { contextFrom, currentTraceparent } from '../src/telemetry/trace-context';

describe('trace context', () => {
  beforeAll(() => new node.NodeTracerProvider().register());
  afterAll(() => trace.disable());

  it('has nothing to carry outside a span', () => {
    expect(currentTraceparent()).toBeNull();
  });

  it('survives being stored and restored by a later worker', () => {
    const tracer = trace.getTracer('test');
    const stored = tracer.startActiveSpan('request', (span) => {
      const value = currentTraceparent();
      span.end();
      return value;
    });

    const child = tracer.startSpan('saga.check', {}, contextFrom(stored));

    expect(stored).toMatch(new RegExp(`^00-${child.spanContext().traceId}-`));
    child.end();
  });

  it.each([[null], [undefined], [''], ['garbage'], [42]])('starts a new trace from %p', (value) => {
    expect(contextFrom(value)).toBe(ROOT_CONTEXT);
  });
});
