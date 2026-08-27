import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import type { DatabasePool } from '../src/db/pool';
import { createRequestId, serializeErrorForLog, serializeRequestForLog } from '../src/lib/logging';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('structured and privacy-bounded logging', () => {
  it('keeps request metadata while excluding credentials, task content and raw query values', () => {
    const serialized = serializeRequestForLog({
      method: 'POST',
      url: '/v1/workspaces/1/tasks/similar?title=confidential-roadmap',
      routeOptions: { url: '/v1/workspaces/:workspaceId/tasks/similar' },
      headers: { authorization: 'Bearer access-secret' },
      body: {
        password: 'password-secret',
        refreshToken: 'refresh-secret',
        title: 'confidential-roadmap',
        description: 'customer incident details',
      },
    });

    expect(serialized).toEqual({
      method: 'POST',
      route: '/v1/workspaces/:workspaceId/tasks/similar',
    });
    const output = JSON.stringify(serialized);
    expect(output).not.toMatch(/access-secret|password-secret|refresh-secret/);
    expect(output).not.toMatch(/confidential-roadmap|customer incident details/);
  });

  it('classifies errors without emitting messages, task content, tokens, stacks or local paths', () => {
    const error = Object.assign(
      new Error('refresh-secret while processing confidential task body'),
      {
        code: 'INTERNAL_ERROR',
        statusCode: 500,
        stack: 'Error: confidential task body\n at C:\\Users\\developer\\project\\server.ts:42',
      },
    );

    expect(serializeErrorForLog(error)).toEqual({
      type: 'Error',
      message: '[REDACTED]',
      stack: '[REDACTED]',
      code: 'INTERNAL_ERROR',
      statusCode: 500,
    });
    const output = JSON.stringify(serializeErrorForLog(error));
    expect(output).not.toMatch(/refresh-secret|confidential task body|Users|server\.ts/);
  });

  it('propagates a validated correlation UUID to response headers and safe errors', async () => {
    const app = await createTestApp();
    const correlationId = '7aee23b1-af34-4c3d-9f45-4ecaf106d68b';
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'x-correlation-id': correlationId },
      payload: {},
    });

    expect(response.statusCode).toBe(422);
    expect(response.headers['x-correlation-id']).toBe(correlationId);
    expect(response.json().error.correlationId).toBe(correlationId);

    const generated = createRequestId({
      headers: { 'x-correlation-id': 'attacker-controlled-sensitive-value' },
    });
    expect(generated).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

async function createTestApp(): Promise<Awaited<ReturnType<typeof buildApp>>> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/fanshuye_logging_test',
    SESSION_SECRET: 'logging-test-session-secret-at-least-32-characters',
    LOG_LEVEL: 'silent',
  });
  const pool = {
    query: vi.fn(),
    connect: vi.fn(),
    end: vi.fn(),
  } as unknown as DatabasePool;
  const app = await buildApp({ config, pool });
  apps.push(app);
  return app;
}
