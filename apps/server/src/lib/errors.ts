import { WireApiErrorSchema, type WireApiError } from '@fanshuye/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

export type ApiErrorCode = WireApiError['error']['code'];

export class ApiError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function sendError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof ApiError) {
    return reply.status(error.statusCode).send(
      WireApiErrorSchema.parse({
        error: {
          code: error.code,
          message: error.message,
          details: normalizeDetails(error.details),
          correlationId: request.id,
        },
      }),
    );
  }

  if (hasStatusCode(error) && error.statusCode === 429) {
    return reply.status(429).send(
      WireApiErrorSchema.parse({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests',
          details: {},
          correlationId: request.id,
        },
      }),
    );
  }
  if (hasStatusCode(error) && error.statusCode >= 400 && error.statusCode < 500) {
    return reply.status(error.statusCode).send(
      WireApiErrorSchema.parse({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request is not valid',
          details: {},
          correlationId: request.id,
        },
      }),
    );
  }

  request.log.error({ err: error }, 'request failed');
  return reply.status(500).send(
    WireApiErrorSchema.parse({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The request could not be completed',
        details: {},
        correlationId: request.id,
      },
    }),
  );
}

function normalizeDetails(details: unknown): Record<string, unknown> {
  return typeof details === 'object' && details !== null && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : {};
}

function hasStatusCode(error: unknown): error is { statusCode: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number'
  );
}
