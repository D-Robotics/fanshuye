import type { AppConfig } from '../../config';
import { hashToken } from '../../lib/security';
import type { VerificationEmail, VerificationEmailSender } from './email';

const RESEND_EMAIL_ENDPOINT = 'https://api.resend.com/emails';
const USER_AGENT = 'fanshuye-server/0.1.0';

type FetchImplementation = typeof fetch;

interface ResendVerificationEmailSenderOptions {
  apiKey: string;
  from: string;
  timeoutMs: number;
  fetchImplementation?: FetchImplementation;
  /** Test-only seam. Production construction always uses the fixed HTTPS endpoint above. */
  endpoint?: string;
}

export class VerificationEmailDeliveryError extends Error {
  public readonly code = 'EMAIL_PROVIDER_ERROR';

  public constructor(public readonly providerStatus?: number) {
    super('Verification email delivery failed');
    this.name = 'VerificationEmailDeliveryError';
  }
}

/**
 * Minimal Resend HTTPS adapter. It deliberately does not surface provider
 * response bodies because they may echo message content, including the
 * verification token.
 */
export class ResendVerificationEmailSender implements VerificationEmailSender {
  private readonly fetchImplementation: FetchImplementation;
  private readonly endpoint: string;

  public constructor(private readonly options: ResendVerificationEmailSenderOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.endpoint = options.endpoint ?? RESEND_EMAIL_ENDPOINT;
  }

  public async sendVerificationEmail(message: VerificationEmail): Promise<void> {
    const payload = buildPayload(this.options.from, message);
    let response: Response;
    try {
      response = await this.fetchImplementation(this.endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': `verify-email/${hashToken(message.token)}`,
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch {
      throw new VerificationEmailDeliveryError();
    }

    if (!response.ok) {
      // Drain the response without retaining or reporting it. Provider errors
      // may include request fields and therefore the verification token.
      await response.arrayBuffer().catch(() => undefined);
      throw new VerificationEmailDeliveryError(response.status);
    }

    const responseBody = await response.json().catch(() => undefined);
    if (!hasDeliveryId(responseBody)) {
      throw new VerificationEmailDeliveryError(response.status);
    }
  }
}

export function createVerificationEmailSender(
  config: AppConfig,
): VerificationEmailSender | undefined {
  if (config.EMAIL_PROVIDER === 'none') return undefined;
  if (!config.RESEND_API_KEY || !config.VERIFICATION_EMAIL_FROM) {
    // loadConfig enforces this. Keep the factory defensive for callers that
    // construct AppConfig-like objects outside the validated startup path.
    throw new Error('Resend verification email configuration is incomplete');
  }
  return new ResendVerificationEmailSender({
    apiKey: config.RESEND_API_KEY,
    from: config.VERIFICATION_EMAIL_FROM,
    timeoutMs: config.EMAIL_DELIVERY_TIMEOUT_MS,
  });
}

function buildPayload(from: string, message: VerificationEmail) {
  const displayName = escapeHtml(message.displayName);
  const token = escapeHtml(message.token);
  const expiresAt = message.expiresAt.toISOString();
  return {
    from,
    to: [message.email],
    subject: '验证你的番薯叶邮箱',
    text: [
      `${message.displayName}，你好：`,
      '',
      `你的番薯叶邮箱验证码是：${message.token}`,
      `验证码有效期至：${expiresAt}`,
      '',
      '如果这不是你的操作，可以忽略此邮件。',
    ].join('\n'),
    html: `<p>${displayName}，你好：</p><p>你的番薯叶邮箱验证码是：<strong>${token}</strong></p><p>验证码有效期至：${expiresAt}</p><p>如果这不是你的操作，可以忽略此邮件。</p>`,
  };
}

function hasDeliveryId(value: unknown): value is { id: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    value.id.length > 0
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
