import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'HTTP requests served',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route'],
  buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const outboxPublished = new Counter({
  name: 'outbox_published_total',
  help: 'Outbox events published to Redis Streams',
  registers: [registry],
});

export const sagaSteps = new Counter({
  name: 'saga_steps_total',
  help: 'Saga steps executed, by result',
  labelNames: ['step', 'outcome'],
  registers: [registry],
});

export const sagaStepDuration = new Histogram({
  name: 'saga_step_duration_seconds',
  help: 'Saga step duration',
  labelNames: ['step'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const circuitRejections = new Counter({
  name: 'ledger_circuit_rejections_total',
  help: 'Ledger calls rejected by the open circuit breaker',
  registers: [registry],
});
