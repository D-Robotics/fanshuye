import type { ApiErrorCode } from '@fanshuye/contracts';

export class DomainError extends Error {
  readonly code: ApiErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ApiErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}
