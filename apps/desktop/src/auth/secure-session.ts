import {
  deleteRefreshCredential,
  readRefreshCredential,
  saveRefreshCredential,
} from '../platform/native';

export interface RefreshCredentialStore {
  save(accountId: string, credential: string): Promise<void>;
  read(accountId: string): Promise<StoredRefreshCredential>;
  delete(accountId: string): Promise<void>;
}

export interface StoredRefreshCredential {
  accountId: string;
  credential: string;
}

export type SecureSessionErrorCode =
  'INVALID_SESSION' | 'SECURE_STORE_UNAVAILABLE' | 'SESSION_NOT_ESTABLISHED';

/**
 * The MVP supports one active desktop session. A fixed OS-keyring account lets
 * the app restore that session after a restart without persisting a user id,
 * email address, or credential in browser storage or SQLite.
 */
export const ACTIVE_NATIVE_SESSION_ACCOUNT = 'active-desktop-session';
const MAX_REFRESH_CREDENTIAL_LENGTH = 512;

/**
 * This error is safe to render. It deliberately never copies native/keyring,
 * network, or credential values into its message or cause.
 */
export class SecureSessionError extends Error {
  constructor(
    readonly code: SecureSessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SecureSessionError';
  }
}

export const nativeRefreshCredentialStore: RefreshCredentialStore = {
  save: (accountId, credential) => {
    const envelope = JSON.stringify({ schemaVersion: 1, accountId, credential });
    return saveRefreshCredential(ACTIVE_NATIVE_SESSION_ACCOUNT, envelope);
  },
  read: async (accountId) => {
    void accountId;
    const envelope = await readRefreshCredential(ACTIVE_NATIVE_SESSION_ACCOUNT);
    const parsed = JSON.parse(envelope) as unknown;
    if (typeof parsed !== 'object' || parsed === null) throw new Error('invalid envelope');
    const candidate = parsed as Record<string, unknown>;
    if (
      candidate.schemaVersion !== 1 ||
      typeof candidate.accountId !== 'string' ||
      candidate.accountId.trim().length === 0 ||
      candidate.accountId.length > 128 ||
      typeof candidate.credential !== 'string' ||
      !isValidOpaqueValue(candidate.credential, MAX_REFRESH_CREDENTIAL_LENGTH)
    ) {
      throw new Error('invalid envelope');
    }
    return { accountId: candidate.accountId, credential: candidate.credential };
  },
  delete: (accountId) => {
    void accountId;
    return deleteRefreshCredential(ACTIVE_NATIVE_SESSION_ACCOUNT);
  },
};

function isValidOpaqueValue(value: string, maximumLength: number): boolean {
  const length = value.trim().length;
  return length >= 16 && length <= maximumLength;
}

/**
 * Access credentials live only in this process memory. Refresh credentials are
 * handed directly to the native OS keyring adapter and are never mirrored into
 * browser storage, SQLite, logs, React state, or error messages.
 */
export class DesktopSecureSession {
  private accountId: string | null = null;
  private accessCredential: string | null = null;
  private accessCredentialExpiresAt: number | null = null;

  constructor(private readonly refreshStore: RefreshCredentialStore) {}

  getAccessCredential(): Promise<string | null> {
    return Promise.resolve(this.accessCredential);
  }

  getAccountId(): string | null {
    return this.accountId;
  }

  prepareRestore(accountId: string): void {
    if (accountId.trim().length === 0 || accountId.length > 128) {
      throw new SecureSessionError('INVALID_SESSION', '登录会话格式无效，请重新登录。');
    }
    this.accountId = accountId;
    this.accessCredential = null;
    this.accessCredentialExpiresAt = null;
  }

  setEphemeralDevelopmentAccessCredential(credential: string | undefined): void {
    this.accessCredential =
      credential !== undefined && isValidOpaqueValue(credential, 8_192) ? credential : null;
    this.accessCredentialExpiresAt =
      this.accessCredential === null ? null : Number.POSITIVE_INFINITY;
  }

  accessCredentialNeedsRefresh(now = Date.now(), leewayMilliseconds = 60_000): boolean {
    return (
      this.accessCredential === null ||
      this.accessCredentialExpiresAt === null ||
      this.accessCredentialExpiresAt <= now + leewayMilliseconds
    );
  }

  async establish(
    accountId: string,
    accessCredential: string,
    refreshCredential: string,
    accessTokenExpiresInSeconds = 900,
  ): Promise<void> {
    if (
      accountId.trim().length === 0 ||
      accountId.length > 128 ||
      !isValidOpaqueValue(accessCredential, 8_192) ||
      !isValidOpaqueValue(refreshCredential, MAX_REFRESH_CREDENTIAL_LENGTH) ||
      !Number.isInteger(accessTokenExpiresInSeconds) ||
      accessTokenExpiresInSeconds < 60 ||
      accessTokenExpiresInSeconds > 86_400
    ) {
      throw new SecureSessionError('INVALID_SESSION', '登录会话格式无效，请重新登录。');
    }

    try {
      await this.refreshStore.save(accountId, refreshCredential);
    } catch (error) {
      if (error instanceof SecureSessionError) throw error;
      throw new SecureSessionError(
        'SECURE_STORE_UNAVAILABLE',
        '无法使用系统安全凭据存储，请重新登录。',
      );
    }
    this.accountId = accountId;
    this.accessCredential = accessCredential;
    this.accessCredentialExpiresAt = Date.now() + accessTokenExpiresInSeconds * 1_000;
  }

  async replaceAfterRefresh(
    accountId: string,
    accessCredential: string,
    refreshCredential: string,
    accessTokenExpiresInSeconds = 900,
  ): Promise<void> {
    if (this.accountId === null) {
      throw new SecureSessionError('SESSION_NOT_ESTABLISHED', '登录会话已失效，请重新登录。');
    }
    await this.establish(
      accountId,
      accessCredential,
      refreshCredential,
      accessTokenExpiresInSeconds,
    );
  }

  async readRefreshCredentialForRotation(allowIdentityRecovery = false): Promise<string> {
    if (this.accountId === null) {
      throw new SecureSessionError('SESSION_NOT_ESTABLISHED', '登录会话已失效，请重新登录。');
    }
    try {
      const stored = await this.refreshStore.read(this.accountId);
      if (!isValidOpaqueValue(stored.credential, 8_192)) throw new Error('invalid credential');
      if (stored.accountId !== this.accountId) {
        if (allowIdentityRecovery && this.accountId === ACTIVE_NATIVE_SESSION_ACCOUNT) {
          this.accountId = stored.accountId;
        } else {
          throw new SecureSessionError(
            'INVALID_SESSION',
            '登录身份已在另一个窗口改变，请重新登录。',
          );
        }
      }
      return stored.credential;
    } catch (error) {
      if (error instanceof SecureSessionError) throw error;
      throw new SecureSessionError(
        'SECURE_STORE_UNAVAILABLE',
        '无法读取系统安全凭据，请重新登录。',
      );
    }
  }

  async clear(): Promise<void> {
    const previousAccountId = this.accountId;
    this.clearEphemeral();
    if (previousAccountId === null) return;
    try {
      await this.refreshStore.delete(previousAccountId);
    } catch {
      throw new SecureSessionError(
        'SECURE_STORE_UNAVAILABLE',
        '本机会话已清除，但系统凭据清理失败。',
      );
    }
  }

  clearEphemeral(): void {
    this.accountId = null;
    this.accessCredential = null;
    this.accessCredentialExpiresAt = null;
  }
}

export function createRuntimeSecureSession(): DesktopSecureSession {
  const session = new DesktopSecureSession(nativeRefreshCredentialStore);
  if (import.meta.env.DEV) {
    session.setEphemeralDevelopmentAccessCredential(import.meta.env.VITE_ACCESS_TOKEN);
  }
  return session;
}
