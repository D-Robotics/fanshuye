import appSource from '../App.tsx?raw';
import cacheSource from '../sync/cache.ts?raw';
import nativeSource from '../platform/native.ts?raw';
import secureSessionSource from './secure-session.ts?raw';
import {
  ACTIVE_NATIVE_SESSION_ACCOUNT,
  DesktopSecureSession,
  SecureSessionError,
  nativeRefreshCredentialStore,
  type RefreshCredentialStore,
} from './secure-session';

function makeStore(): RefreshCredentialStore & {
  save: ReturnType<typeof vi.fn<RefreshCredentialStore['save']>>;
  read: ReturnType<typeof vi.fn<RefreshCredentialStore['read']>>;
  delete: ReturnType<typeof vi.fn<RefreshCredentialStore['delete']>>;
} {
  return {
    save: vi.fn<RefreshCredentialStore['save']>(() => Promise.resolve()),
    read: vi.fn<RefreshCredentialStore['read']>(() =>
      Promise.resolve({
        accountId: 'account-ada',
        credential: 'refresh-credential-from-keyring',
      }),
    ),
    delete: vi.fn<RefreshCredentialStore['delete']>(() => Promise.resolve()),
  };
}

describe('desktop secure session boundary', () => {
  it('keeps access credentials in memory and delegates refresh credentials only to the keyring', async () => {
    const store = makeStore();
    const session = new DesktopSecureSession(store);
    const browserStorageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const accessCredential = 'access-credential-123456789';
    const refreshCredential = 'refresh-credential-987654321';

    await session.establish('account-ada', accessCredential, refreshCredential);

    expect(store.save).toHaveBeenCalledWith('account-ada', refreshCredential);
    await expect(session.getAccessCredential()).resolves.toBe(accessCredential);
    await expect(session.readRefreshCredentialForRotation()).resolves.toBe(
      'refresh-credential-from-keyring',
    );
    expect(browserStorageWrite).not.toHaveBeenCalled();
    browserStorageWrite.mockRestore();
  });

  it('replaces native failures with a render-safe error that cannot echo the credential', async () => {
    const store = makeStore();
    const secret = 'refresh-secret-that-must-never-reach-ui';
    store.save.mockRejectedValue(new Error(`keyring provider echoed ${secret}`));
    const session = new DesktopSecureSession(store);

    const error = await session
      .establish('account-ada', 'access-credential-123456789', secret)
      .catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(SecureSessionError);
    expect(String(error)).toBe('SecureSessionError: 无法使用系统安全凭据存储，请重新登录。');
    expect(String(error)).not.toContain(secret);
    expect(await session.getAccessCredential()).toBeNull();
  });

  it('fails closed outside Tauri instead of falling back to browser storage', async () => {
    const session = new DesktopSecureSession(nativeRefreshCredentialStore);
    const browserStorageWrite = vi.spyOn(Storage.prototype, 'setItem');

    await expect(
      session.establish(
        'account-ada',
        'access-credential-123456789',
        'refresh-credential-987654321',
      ),
    ).rejects.toMatchObject({ code: 'SECURE_STORE_UNAVAILABLE' });
    expect(browserStorageWrite).not.toHaveBeenCalled();
    browserStorageWrite.mockRestore();
  });

  it('rejects refresh credentials larger than the server contract before keyring storage', async () => {
    const store = makeStore();
    const session = new DesktopSecureSession(store);

    await expect(
      session.establish('account-ada', 'access-credential-123456789', 'r'.repeat(513)),
    ).rejects.toMatchObject({ code: 'INVALID_SESSION' });
    expect(store.save).not.toHaveBeenCalled();
  });

  it('locks the source boundary against browser storage, SQLite, logs and optional native fallback', () => {
    expect(appSource).not.toMatch(/localStorage|sessionStorage/);
    expect(cacheSource).not.toMatch(
      /refresh(?:Token|Credential)|access(?:Token|Credential)|password|clientSecret/i,
    );
    expect(secureSessionSource).not.toMatch(/localStorage|sessionStorage|console\s*\./);
    expect(nativeSource).toContain("invokeRequiredNative('store_refresh_credential'");
    expect(nativeSource).toContain("invokeRequiredNative<string>('read_refresh_credential'");
    expect(nativeSource).toContain("invokeRequiredNative('delete_refresh_credential'");
  });

  it('uses a fixed native keyring slot so the active session can be restored after restart', () => {
    expect(ACTIVE_NATIVE_SESSION_ACCOUNT).toBe('active-desktop-session');
    expect(secureSessionSource).toContain(
      'saveRefreshCredential(ACTIVE_NATIVE_SESSION_ACCOUNT, envelope)',
    );
    expect(secureSessionSource).toContain('readRefreshCredential(ACTIVE_NATIVE_SESSION_ACCOUNT)');
    expect(secureSessionSource).toContain('deleteRefreshCredential(ACTIVE_NATIVE_SESSION_ACCOUNT)');
  });
});
