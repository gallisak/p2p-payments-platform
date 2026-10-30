import { trace } from '@opentelemetry/api';
import { node } from '@opentelemetry/sdk-node';
import { JsonLogger } from '../src/telemetry/json-logger';

describe('JsonLogger', () => {
  let lines: string[];
  let write: jest.SpyInstance;

  beforeAll(() => new node.NodeTracerProvider().register());
  afterAll(() => trace.disable());

  beforeEach(() => {
    lines = [];
    write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
  });

  afterEach(() => write.mockRestore());

  it('writes one JSON line with the service and the context', () => {
    new JsonLogger().log('started', 'Bootstrap');

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ level: 'info', message: 'started', context: 'Bootstrap' });
    expect(JSON.parse(lines[0]).service).toBeTruthy();
    expect(lines[0].endsWith('\n')).toBe(true);
  });

  it('adds the trace of the active span', () => {
    const traceId = trace.getTracer('test').startActiveSpan('work', (span) => {
      new JsonLogger().warn('slow', 'Worker');
      span.end();
      return span.spanContext().traceId;
    });

    expect(JSON.parse(lines[0])).toMatchObject({ level: 'warn', traceId });
  });

  it('keeps the stack of an error apart from its context', () => {
    new JsonLogger().error('boom', 'stack trace', 'Worker');

    expect(JSON.parse(lines[0])).toMatchObject({ level: 'error', message: 'boom', stack: 'stack trace', context: 'Worker' });
  });
});
