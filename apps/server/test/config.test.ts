import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('server configuration', () => {
  it('fails early with readable messages when required configuration is missing', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgres://localhost/fanshuye', SESSION_SECRET: 'short' }),
    ).toThrow(/SESSION_SECRET/);
  });

  it('parses bounded settings and allowed origins', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://localhost/fanshuye_test',
      SESSION_SECRET: 'a-secure-development-secret-with-32-chars',
      ALLOWED_ORIGINS: 'http://localhost:1420, tauri://localhost',
      PORT: '4310',
      METRICS_TOKEN: 'dedicated-metrics-token-at-least-32-characters',
    });
    expect(config.PORT).toBe(4310);
    expect(config.allowedOrigins).toEqual(['http://localhost:1420', 'tauri://localhost']);
    expect(config.METRICS_TOKEN).toBe('dedicated-metrics-token-at-least-32-characters');
  });

  it('rejects short metrics credentials instead of exposing a weak internal endpoint', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://localhost/fanshuye_test',
        SESSION_SECRET: 'a-secure-development-secret-with-32-chars',
        METRICS_TOKEN: 'too-short',
      }),
    ).toThrow(/METRICS_TOKEN/);
  });

  it('requires an explicitly configured Resend sender in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://localhost/fanshuye',
        SESSION_SECRET: 'a-secure-production-secret-with-32-characters',
      }),
    ).toThrow(/EMAIL_PROVIDER/);

    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://localhost/fanshuye',
        SESSION_SECRET: 'a-secure-production-secret-with-32-characters',
        EMAIL_PROVIDER: 'resend',
      }),
    ).toThrow(/RESEND_API_KEY.*VERIFICATION_EMAIL_FROM/);
  });

  it('accepts a complete production email configuration and rejects header injection', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://localhost/fanshuye',
      SESSION_SECRET: 'a-secure-production-secret-with-32-characters',
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_test-key-never-used-for-delivery',
      VERIFICATION_EMAIL_FROM: '番薯叶 <no-reply@example.com>',
    });
    expect(config.EMAIL_PROVIDER).toBe('resend');
    expect(config.EMAIL_DELIVERY_TIMEOUT_MS).toBe(10_000);

    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://localhost/fanshuye',
        SESSION_SECRET: 'a-secure-production-secret-with-32-characters',
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_test-key-never-used-for-delivery',
        VERIFICATION_EMAIL_FROM: '番薯叶 <no-reply@example.com>\r\nBcc: attacker@example.com',
      }),
    ).toThrow(/VERIFICATION_EMAIL_FROM/);
  });
});
