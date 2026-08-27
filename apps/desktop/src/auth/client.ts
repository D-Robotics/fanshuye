import { z } from 'zod';
import type { DesktopSecureSession } from './secure-session';

const SessionResponseSchema = z.object({
  accessToken: z.string().min(16).max(8_192),
  refreshToken: z.string().min(16).max(512),
  accessTokenExpiresInSeconds: z.number().int().min(60).max(86_400),
  user: z.object({ id: z.string().min(1).max(128) }),
});

export type DesktopAuthenticationErrorCode =
  'NETWORK' | 'AUTHENTICATION_REQUIRED' | 'INVALID_RESPONSE' | 'COORDINATION_UNAVAILABLE';

export class DesktopAuthenticationError extends Error {
  constructor(
    readonly code: DesktopAuthenticationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DesktopAuthenticationError';
  }
}

type RequestImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type SessionRotationLock = (work: () => Promise<void>) => Promise<void>;

async function runWithDesktopSessionLock(work: () => Promise<void>): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.locks !== undefined) {
    await navigator.locks.request('fanshuye-active-session-rotation', { mode: 'exclusive' }, work);
    return;
  }
  throw new DesktopAuthenticationError(
    'COORDINATION_UNAVAILABLE',
    '当前系统无法安全协调桌面会话，请重新启动番薯叶。',
  );
}

/**
 * Coordinates login and refresh rotation without exposing credential-bearing
 * responses to React. Refresh values move directly between HTTPS and the OS
 * keyring-backed session boundary.
 */
export class DesktopAuthenticationClient {
  constructor(
    private readonly apiUrl: string,
    private readonly session: DesktopSecureSession,
    private readonly request: RequestImplementation = fetch,
    private readonly runExclusive: SessionRotationLock = runWithDesktopSessionLock,
  ) {}

  async login(email: string, password: string): Promise<void> {
    await this.runExclusive(async () => {
      const tokens = await this.requestSession('/v1/auth/login', { email, password });
      try {
        await this.session.establish(
          tokens.user.id,
          tokens.accessToken,
          tokens.refreshToken,
          tokens.accessTokenExpiresInSeconds,
        );
      } catch (error) {
        await this.revokeBestEffort(tokens.accessToken);
        throw error;
      }
    });
  }

  async restore(accountId: string): Promise<void> {
    await this.runExclusive(async () => {
      this.session.prepareRestore(accountId);
      await this.rotateSession(true);
    });
  }

  async refresh(): Promise<void> {
    await this.runExclusive(async () => {
      await this.rotateSession();
    });
  }

  async getValidAccessCredential(): Promise<string | null> {
    await this.runExclusive(async () => {
      if (this.session.accessCredentialNeedsRefresh()) await this.rotateSession();
    });
    return this.session.getAccessCredential();
  }

  async logout(): Promise<void> {
    await this.runExclusive(async () => {
      const accessCredential = await this.session.getAccessCredential();
      let cleanupError: unknown = null;
      try {
        // Clear process memory and the keyring before waiting on an unreliable network.
        await this.session.clear();
      } catch (error) {
        cleanupError = error;
      }
      if (accessCredential !== null) await this.revokeBestEffort(accessCredential);
      if (cleanupError !== null) throw cleanupError;
    });
  }

  private async requestSession(
    path: string,
    body: unknown,
  ): Promise<z.infer<typeof SessionResponseSchema>> {
    let response: Response;
    try {
      response = await this.request(new URL(path, this.apiUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new DesktopAuthenticationError('NETWORK', '无法连接登录服务，请稍后重试。');
    }
    if (!response.ok) {
      throw new DesktopAuthenticationError(
        response.status === 401 ? 'AUTHENTICATION_REQUIRED' : 'NETWORK',
        response.status === 401 ? '登录会话已失效，请重新登录。' : '登录服务暂时不可用。',
      );
    }
    try {
      return SessionResponseSchema.parse(await response.json());
    } catch {
      throw new DesktopAuthenticationError('INVALID_RESPONSE', '登录服务返回了无效响应。');
    }
  }

  private async rotateSession(allowIdentityRecovery = false): Promise<void> {
    // Read only after taking the cross-window lock. A sibling Tauri webview
    // may have rotated the single-use credential while this window waited.
    const refreshCredential =
      await this.session.readRefreshCredentialForRotation(allowIdentityRecovery);
    const expectedAccountId = this.session.getAccountId();
    if (expectedAccountId === null) {
      throw new DesktopAuthenticationError(
        'AUTHENTICATION_REQUIRED',
        '登录会话已失效，请重新登录。',
      );
    }
    const tokens = await this.requestSession('/v1/auth/refresh', {
      refreshToken: refreshCredential,
    });
    if (tokens.user.id !== expectedAccountId) {
      throw new DesktopAuthenticationError(
        'AUTHENTICATION_REQUIRED',
        '登录身份已改变，请重新登录。',
      );
    }
    await this.session.replaceAfterRefresh(
      tokens.user.id,
      tokens.accessToken,
      tokens.refreshToken,
      tokens.accessTokenExpiresInSeconds,
    );
  }

  private async revokeBestEffort(accessCredential: string): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        this.request(new URL('/v1/auth/logout', this.apiUrl), {
          method: 'POST',
          headers: { authorization: `Bearer ${accessCredential}` },
        }),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 5_000);
        }),
      ]);
    } catch {
      // The safe-store error remains the only user-facing diagnostic.
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
  }
}
