import clientSource from './client.ts?raw';
import { DesktopAuthenticationClient, type SessionRotationLock } from './client';
import { DesktopSecureSession, type RefreshCredentialStore } from './secure-session';

const immediateLock: SessionRotationLock = (work) => work();

function sessionResponse(accessToken: string, refreshToken: string): Response {
  return new Response(
    JSON.stringify({
      accessToken,
      refreshToken,
      accessTokenExpiresInSeconds: 900,
      user: { id: 'account-ada' },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function sessionResponseFor(
  accountId: string,
  accessToken: string,
  refreshToken: string,
): Response {
  return new Response(
    JSON.stringify({
      accessToken,
      refreshToken,
      accessTokenExpiresInSeconds: 900,
      user: { id: accountId },
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

describe('desktop authentication client', () => {
  it('moves login and rotated refresh credentials directly into the secure store', async () => {
    const store: RefreshCredentialStore = {
      save: vi.fn(() => Promise.resolve()),
      read: vi.fn(() =>
        Promise.resolve({
          accountId: 'account-ada',
          credential: 'refresh-credential-before-rotation',
        }),
      ),
      delete: vi.fn(() => Promise.resolve()),
    };
    const session = new DesktopSecureSession(store);
    const request = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        sessionResponse('access-credential-after-login', 'refresh-credential-after-login'),
      )
      .mockResolvedValueOnce(
        sessionResponse('access-credential-after-refresh', 'refresh-credential-after-refresh'),
      );
    const client = new DesktopAuthenticationClient(
      'https://api.fanshuye.test',
      session,
      request,
      immediateLock,
    );
    const browserStorageWrite = vi.spyOn(Storage.prototype, 'setItem');

    await client.login('ada@example.com', 'correct horse battery staple');
    expect(store.save).toHaveBeenNthCalledWith(1, 'account-ada', 'refresh-credential-after-login');

    await client.refresh();
    expect(store.read).toHaveBeenCalledWith('account-ada');
    expect(store.save).toHaveBeenNthCalledWith(
      2,
      'account-ada',
      'refresh-credential-after-refresh',
    );
    await expect(session.getAccessCredential()).resolves.toBe('access-credential-after-refresh');
    expect(browserStorageWrite).not.toHaveBeenCalled();
    browserStorageWrite.mockRestore();
  });

  it('does not echo a refresh credential when HTTPS refresh fails', async () => {
    const secret = 'refresh-credential-provider-must-not-echo';
    const store: RefreshCredentialStore = {
      save: vi.fn(() => Promise.resolve()),
      read: vi.fn(() => Promise.resolve({ accountId: 'account-ada', credential: secret })),
      delete: vi.fn(() => Promise.resolve()),
    };
    const session = new DesktopSecureSession(store);
    session.prepareRestore('account-ada');
    const request = vi.fn(() => Promise.reject(new Error(`provider echoed ${secret}`)));
    const client = new DesktopAuthenticationClient(
      'https://api.fanshuye.test',
      session,
      request,
      immediateLock,
    );

    const error = await client.refresh().catch((failure: unknown) => failure);

    expect(String(error)).toBe('DesktopAuthenticationError: 无法连接登录服务，请稍后重试。');
    expect(String(error)).not.toContain(secret);
    expect(clientSource).not.toMatch(/localStorage|sessionStorage|console\s*\./);
  });

  it('rejects a refresh credential larger than the server contract before secure storage', async () => {
    const store: RefreshCredentialStore = {
      save: vi.fn(() => Promise.resolve()),
      read: vi.fn(() =>
        Promise.resolve({ accountId: 'account-ada', credential: 'refresh-credential' }),
      ),
      delete: vi.fn(() => Promise.resolve()),
    };
    const client = new DesktopAuthenticationClient(
      'https://api.fanshuye.test',
      new DesktopSecureSession(store),
      vi.fn(() => Promise.resolve(sessionResponse('access-credential-valid', 'r'.repeat(513)))),
      immediateLock,
    );

    await expect(
      client.login('ada@example.com', 'correct horse battery staple'),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(store.save).not.toHaveBeenCalled();
  });

  it('restores the active keyring slot and replaces it with the authenticated user identity', async () => {
    const store: RefreshCredentialStore = {
      save: vi.fn(() => Promise.resolve()),
      read: vi.fn(() =>
        Promise.resolve({
          accountId: 'authenticated-user-id',
          credential: 'refresh-credential-before-restart',
        }),
      ),
      delete: vi.fn(() => Promise.resolve()),
    };
    const session = new DesktopSecureSession(store);
    const request = vi.fn(() =>
      Promise.resolve(
        sessionResponseFor(
          'authenticated-user-id',
          'access-credential-after-restore',
          'refresh-credential-after-restore',
        ),
      ),
    );
    const client = new DesktopAuthenticationClient(
      'https://api.fanshuye.test',
      session,
      request,
      immediateLock,
    );

    await client.restore('active-desktop-session');

    expect(store.read).toHaveBeenCalledWith('active-desktop-session');
    expect(store.save).toHaveBeenCalledWith(
      'authenticated-user-id',
      'refresh-credential-after-restore',
    );
    expect(session.getAccountId()).toBe('authenticated-user-id');
  });

  it('serializes two window restores and reads the latest single-use refresh credential', async () => {
    let storedRefresh = 'refresh-generation-0001';
    let generation = 1;
    let lockTail = Promise.resolve();
    const runExclusive = (work: () => Promise<void>) => {
      const next = lockTail.then(work);
      lockTail = next.catch(() => undefined);
      return next;
    };
    const makeStore = (): RefreshCredentialStore => ({
      save: vi.fn((_accountId, credential) => {
        storedRefresh = credential;
        return Promise.resolve();
      }),
      read: vi.fn(() =>
        Promise.resolve({ accountId: 'authenticated-user-id', credential: storedRefresh }),
      ),
      delete: vi.fn(() => Promise.resolve()),
    });
    const request = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const supplied = (JSON.parse(String(init?.body)) as { refreshToken: string }).refreshToken;
      expect(supplied).toBe(`refresh-generation-${generation.toString().padStart(4, '0')}`);
      generation += 1;
      return Promise.resolve(
        sessionResponseFor(
          'authenticated-user-id',
          `access-generation-${generation.toString().padStart(4, '0')}`,
          `refresh-generation-${generation.toString().padStart(4, '0')}`,
        ),
      );
    });
    const first = new DesktopAuthenticationClient(
      'https://api.fanshuye.test',
      new DesktopSecureSession(makeStore()),
      request,
      runExclusive,
    );
    const second = new DesktopAuthenticationClient(
      'https://api.fanshuye.test',
      new DesktopSecureSession(makeStore()),
      request,
      runExclusive,
    );

    await Promise.all([
      first.restore('active-desktop-session'),
      second.restore('active-desktop-session'),
    ]);

    expect(request).toHaveBeenCalledTimes(2);
    expect(storedRefresh).toBe('refresh-generation-0003');
  });

  it('refreshes an expiring access credential before transport use and reuses the fresh token', async () => {
    let storedRefresh = 'refresh-credential-after-login';
    const store: RefreshCredentialStore = {
      save: vi.fn((_accountId, credential) => {
        storedRefresh = credential;
        return Promise.resolve();
      }),
      read: vi.fn(() => Promise.resolve({ accountId: 'account-ada', credential: storedRefresh })),
      delete: vi.fn(() => Promise.resolve()),
    };
    const request = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accessToken: 'access-credential-expiring',
            refreshToken: storedRefresh,
            accessTokenExpiresInSeconds: 60,
            user: { id: 'account-ada' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        sessionResponse('access-credential-refreshed', 'refresh-credential-refreshed'),
      );
    const session = new DesktopSecureSession(store);
    const client = new DesktopAuthenticationClient(
      'https://api.fanshuye.test',
      session,
      request,
      immediateLock,
    );

    await client.login('ada@example.com', 'correct horse battery staple');
    await expect(client.getValidAccessCredential()).resolves.toBe('access-credential-refreshed');
    await expect(client.getValidAccessCredential()).resolves.toBe('access-credential-refreshed');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('fails closed before consuming a refresh credential owned by another window identity', async () => {
    const store: RefreshCredentialStore = {
      save: vi.fn(() => Promise.resolve()),
      read: vi.fn(() =>
        Promise.resolve({
          accountId: 'account-grace',
          credential: 'refresh-credential-for-grace',
        }),
      ),
      delete: vi.fn(() => Promise.resolve()),
    };
    const session = new DesktopSecureSession(store);
    await session.establish(
      'account-ada',
      'access-credential-for-ada',
      'refresh-credential-for-ada',
    );
    const request = vi.fn(() =>
      Promise.resolve(
        sessionResponseFor(
          'account-grace',
          'access-credential-for-grace',
          'refresh-credential-next-grace',
        ),
      ),
    );
    const client = new DesktopAuthenticationClient(
      'https://api.fanshuye.test',
      session,
      request,
      immediateLock,
    );

    await expect(client.refresh()).rejects.toMatchObject({ code: 'INVALID_SESSION' });
    expect(request).not.toHaveBeenCalled();
    expect(session.getAccountId()).toBe('account-ada');
  });
});
