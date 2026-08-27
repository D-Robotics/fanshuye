import { randomUUID } from 'node:crypto';

const correlationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RequestIdSource {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Accept only a bounded UUID from an untrusted correlation header. This keeps
 * request identifiers useful across services without allowing log injection or
 * attacker-controlled high-cardinality identifiers.
 */
export function createRequestId(request: RequestIdSource): string {
  const header = request.headers['x-correlation-id'];
  const candidate = Array.isArray(header) ? header[0] : header;
  return candidate !== undefined && correlationIdPattern.test(candidate) ? candidate : randomUUID();
}

/**
 * Pino request serializers must never include headers, query values or bodies.
 * Route templates are application-owned; raw URLs can contain task titles and
 * other user content, so they are intentionally omitted.
 */
export function serializeRequestForLog(value: unknown): Record<string, unknown> {
  const request = asRecord(value);
  const routeOptions = asRecord(request?.routeOptions);
  return compact({
    method: stringValue(request?.method),
    route: stringValue(routeOptions?.url),
  });
}

export function serializeResponseForLog(value: unknown): Record<string, unknown> {
  const response = asRecord(value);
  return compact({ statusCode: numberValue(response?.statusCode) });
}

/**
 * Unexpected error messages and stacks can echo task bodies, credentials or
 * absolute developer paths. Keep only bounded diagnostic classifications in
 * production logs; the correlation ID can be used to inspect protected traces.
 */
export function serializeErrorForLog(value: unknown): {
  [key: string]: unknown;
  type: string;
  message: string;
  stack: string;
} {
  const error = asRecord(value);
  return {
    type: value instanceof Error ? value.name : (stringValue(error?.name) ?? 'UnknownError'),
    message: '[REDACTED]',
    stack: '[REDACTED]',
    ...compact({
      code: safeDiagnosticCode(error?.code),
      statusCode: numberValue(error?.statusCode),
    }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeDiagnosticCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value) ? value : undefined;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
