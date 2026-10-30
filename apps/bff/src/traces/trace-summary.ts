interface JaegerTag {
  key: string;
  value: unknown;
}

interface JaegerSpan {
  operationName: string;
  processID: string;
  startTime: number;
  duration: number;
  tags?: JaegerTag[];
}

interface JaegerTrace {
  traceID: string;
  spans: JaegerSpan[];
  processes: Record<string, { serviceName: string }>;
}

export interface SagaStepTiming {
  step: string;
  outcome: unknown;
  attempt: unknown;
  durationMs: number;
}

export interface TraceSpan {
  service: string;
  operation: string;
  startOffsetMs: number;
  durationMs: number;
  error: boolean;
}

export interface TraceSummary {
  traceId: string;
  startedAt: string;
  durationMs: number;
  services: string[];
  transferId: unknown;
  steps: SagaStepTiming[];
  spans: TraceSpan[];
}

const toMs = (micros: number) => Math.round(micros / 100) / 10;
const tag = (span: JaegerSpan, key: string) => span.tags?.find((t) => t.key === key)?.value;

function summarize(raw: JaegerTrace): TraceSummary {
  const spans = [...raw.spans].sort((a, b) => a.startTime - b.startTime);
  const startedAt = spans[0].startTime;
  const endedAt = Math.max(...spans.map((s) => s.startTime + s.duration));
  const sagaSpans = spans.filter((s) => s.operationName.startsWith('saga.'));
  const serviceOf = (span: JaegerSpan) => raw.processes[span.processID]?.serviceName ?? 'unknown';
  return {
    traceId: raw.traceID,
    startedAt: new Date(startedAt / 1000).toISOString(),
    durationMs: toMs(endedAt - startedAt),
    services: [...new Set(spans.map(serviceOf))].sort(),
    transferId: sagaSpans.length > 0 ? tag(sagaSpans[0], 'transfer.id') : null,
    steps: sagaSpans.map((s) => ({
      step: s.operationName.slice('saga.'.length),
      outcome: tag(s, 'saga.outcome'),
      attempt: tag(s, 'saga.attempt'),
      durationMs: toMs(s.duration),
    })),
    spans: spans.map((s) => ({
      service: serviceOf(s),
      operation: s.operationName,
      startOffsetMs: toMs(s.startTime - startedAt),
      durationMs: toMs(s.duration),
      error: tag(s, 'error') === true,
    })),
  };
}

export function summarizeTraces(body: unknown): TraceSummary[] {
  const data = (body as { data?: JaegerTrace[] | null } | undefined)?.data ?? [];
  return data
    .filter((t) => t.spans.length > 0)
    .map(summarize)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
