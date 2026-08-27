import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { hashToken } from '../src/lib/security';
import {
  ResendVerificationEmailSender,
  VerificationEmailDeliveryError,
} from '../src/modules/auth/resend-email';

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

describe('Resend verification email adapter', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  });

  it('sends the documented request with a hashed idempotency key', async () => {
    const fake = await startFakeResend(200, { id: 'email_123' });
    server = fake.server;
    const apiKey = 're_local-test-secret';
    const token = 'verification-token-that-must-not-be-in-headers';
    const sender = new ResendVerificationEmailSender({
      apiKey,
      from: '番薯叶 <no-reply@example.com>',
      timeoutMs: 2_000,
      endpoint: fake.endpoint,
    });

    await sender.sendVerificationEmail({
      email: 'developer@example.com',
      displayName: '<Developer & Friend>',
      token,
      expiresAt: new Date('2026-08-27T00:00:00.000Z'),
    });

    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0]!;
    expect(request).toMatchObject({ method: 'POST', url: '/emails' });
    expect(request.headers).toMatchObject({
      accept: 'application/json',
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'idempotency-key': `verify-email/${hashToken(token)}`,
      'user-agent': 'fanshuye-server/0.1.0',
    });
    expect(request.headers['idempotency-key']).not.toContain(token);

    const payload = JSON.parse(request.body) as Record<string, unknown>;
    expect(payload).toMatchObject({
      from: '番薯叶 <no-reply@example.com>',
      to: ['developer@example.com'],
      subject: '验证你的番薯叶邮箱',
    });
    expect(payload.text).toContain(token);
    expect(payload.html).toContain('&lt;Developer &amp; Friend&gt;');
    expect(payload.html).not.toContain('<Developer & Friend>');
    expect(request.body).not.toContain(apiKey);
  });

  it('turns provider rejections into a stable error without echoing secrets', async () => {
    const token = 'verification-token-provider-echoed';
    const apiKey = 're_local-provider-secret';
    const fake = await startFakeResend(422, {
      name: 'validation_error',
      message: `provider echoed ${token} and ${apiKey}`,
    });
    server = fake.server;
    const sender = new ResendVerificationEmailSender({
      apiKey,
      from: 'no-reply@example.com',
      timeoutMs: 2_000,
      endpoint: fake.endpoint,
    });

    const error = await sender
      .sendVerificationEmail({
        email: 'developer@example.com',
        displayName: 'Developer',
        token,
        expiresAt: new Date('2026-08-27T00:00:00.000Z'),
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(VerificationEmailDeliveryError);
    expect(error).toMatchObject({ code: 'EMAIL_PROVIDER_ERROR', providerStatus: 422 });
    expect(String(error)).toBe(
      'VerificationEmailDeliveryError: Verification email delivery failed',
    );
    expect(String(error)).not.toContain(token);
    expect(String(error)).not.toContain(apiKey);
  });

  it('rejects a malformed success response instead of reporting delivery', async () => {
    const fake = await startFakeResend(200, { accepted: true });
    server = fake.server;
    const sender = new ResendVerificationEmailSender({
      apiKey: 're_local-test-secret',
      from: 'no-reply@example.com',
      timeoutMs: 2_000,
      endpoint: fake.endpoint,
    });

    await expect(
      sender.sendVerificationEmail({
        email: 'developer@example.com',
        displayName: 'Developer',
        token: 'verification-token',
        expiresAt: new Date('2026-08-27T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'EMAIL_PROVIDER_ERROR', providerStatus: 200 });
  });

  async function startFakeResend(status: number, responseBody: unknown) {
    const requests: CapturedRequest[] = [];
    const localServer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(responseBody));
    });
    await new Promise<void>((resolve, reject) => {
      localServer.once('error', reject);
      localServer.listen(0, '127.0.0.1', () => resolve());
    });
    const address = localServer.address();
    if (!address || typeof address === 'string') throw new Error('Fake server did not bind to TCP');
    return {
      server: localServer,
      endpoint: `http://127.0.0.1:${address.port}/emails`,
      requests,
    };
  }
});
