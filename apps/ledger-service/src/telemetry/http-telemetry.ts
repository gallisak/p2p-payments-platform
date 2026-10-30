import { trace } from '@opentelemetry/api';
import { NextFunction, Request, Response } from 'express';
import { writeLog } from './json-logger';
import { httpDuration, httpRequests } from './metrics';

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
    const elapsedMs = performance.now() - startedAt;
    const durationMs = Math.round(elapsedMs);
    const route = (req.route as { path?: string } | undefined)?.path ?? 'unmatched';
    httpRequests.inc({ method: req.method, route, status: res.statusCode });
    httpDuration.observe({ method: req.method, route }, elapsedMs / 1000);
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
