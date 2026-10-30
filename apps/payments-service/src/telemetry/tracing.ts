import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { NodeSDK, tracing } from '@opentelemetry/sdk-node';
import { IncomingMessage } from 'http';

const UNTRACED_PATHS = /^\/(health|metrics|socket\.io)(\/|\?|$)/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/+$/, '');

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME ?? 'payments-service',
  spanProcessors: endpoint
    ? [new tracing.BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }))]
    : [],
  instrumentations: [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (req) => UNTRACED_PATHS.test(req.url ?? ''),
      requestHook: (span, req) => {
        if (req instanceof IncomingMessage) {
          const path = (req.url ?? '').split('?')[0].replace(UUID, ':id');
          span.updateName(`${req.method} ${path}`);
        }
      },
    }),
    new UndiciInstrumentation(),
  ],
});

sdk.start();
process.once('SIGTERM', () => void sdk.shutdown().catch(() => undefined));
