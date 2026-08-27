import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const verificationEmailFromSchema = z
  .string()
  .trim()
  .min(3)
  .max(400)
  .refine((value) => !/[\r\n]/.test(value), 'must not contain line breaks')
  .refine((value) => {
    const friendlyAddress = /<([^<>]+)>$/.exec(value);
    return z
      .email()
      .max(320)
      .safeParse(friendlyAddress?.[1] ?? value).success;
  }, 'must be an email address or a friendly name followed by <email@example.com>');

export const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4310),
    DATABASE_URL: z.string().url().startsWith('postgres'),
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must contain at least 32 characters'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    ALLOWED_ORIGINS: z.string().default('http://localhost:1420,tauri://localhost'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    TRUST_PROXY: booleanFromString,
    SYNC_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    DEPENDENCY_QUERY_TIMEOUT_MS: z.coerce.number().int().min(50).max(10_000).default(1_500),
    DEPENDENCY_QUERY_MAX_NODES: z.coerce.number().int().min(1).max(5_000).default(250),
    METRICS_TOKEN: z.string().min(32).max(512).optional(),
    EMAIL_PROVIDER: z.enum(['none', 'resend']).default('none'),
    RESEND_API_KEY: z.string().min(8).max(512).startsWith('re_').optional(),
    VERIFICATION_EMAIL_FROM: verificationEmailFromSchema.optional(),
    EMAIL_DELIVERY_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === 'production' && value.EMAIL_PROVIDER !== 'resend') {
      context.addIssue({
        code: 'custom',
        path: ['EMAIL_PROVIDER'],
        message: 'must be resend in production',
      });
    }
    if (value.EMAIL_PROVIDER !== 'resend') return;
    if (!value.RESEND_API_KEY) {
      context.addIssue({
        code: 'custom',
        path: ['RESEND_API_KEY'],
        message: 'is required when EMAIL_PROVIDER=resend',
      });
    }
    if (!value.VERIFICATION_EMAIL_FROM) {
      context.addIssue({
        code: 'custom',
        path: ['VERIFICATION_EMAIL_FROM'],
        message: 'is required when EMAIL_PROVIDER=resend',
      });
    }
  })
  .transform((value) => ({
    ...value,
    allowedOrigins: value.ALLOWED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  }));

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = ConfigSchema.safeParse(environment);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'configuration'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid server configuration: ${details}`);
  }
  return result.data;
}
