import { trace } from '@opentelemetry/api';
import { NextFunction, Request, Response } from 'express';
import { writeLog } from './json-logger';

const UNOBSERVED_PATHS = /^\/(health|metrics|socket\.io)(\/|$)/;

export function httpTelemetry(req: Request, res: Response, next: NextFunction): void {
  const path = req.originalUrl.split('?')[0];
  if (UNOBSERVED_PATHS.test(path)) {
    next();
    return;
  }
  const traceId = trace.getActiveSpan()?.spanContext().traceId;
  if (traceId) {
    res.setHeader('x-trace-id', traceId);
  }
  const startedAt = performance.now();
  res.once('finish', () => {
    const durationMs = Math.round(performance.now() - startedAt);
    writeLog('info', 'http', `${req.method} ${path} ${res.statusCode}`, {
      method: req.method,
      path,
      status: res.statusCode,
      durationMs,
      traceId,
    });
  });
  next();
}
