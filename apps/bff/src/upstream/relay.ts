import { Response } from 'express';
import { UpstreamResponse } from './upstream.client';

export function relay(res: Response, upstream: UpstreamResponse): unknown {
  res.status(upstream.status);
  if (upstream.replayed !== undefined) {
    res.setHeader('Idempotent-Replayed', upstream.replayed);
  }
  if (upstream.retryAfter !== undefined) {
    res.setHeader('Retry-After', upstream.retryAfter);
  }
  return upstream.body;
}
