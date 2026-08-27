import { describe, expect, it } from 'vitest';
import {
  hashToken,
  isAllowedWebSocketOrigin,
  isSafeExternalUrl,
  readBearerToken,
  readWebSocketProtocolToken,
  signAccessToken,
  verifyAccessToken,
} from '../src/lib/security';

describe('security helpers', () => {
  it('signs and verifies scoped access-token claims', async () => {
    const secret = 'this-test-secret-is-longer-than-thirty-two-characters';
    const token = await signAccessToken(
      {
        userId: '10000000-0000-4000-8000-000000000001',
        sessionId: '20000000-0000-4000-8000-000000000001',
      },
      secret,
      60,
    );
    await expect(verifyAccessToken(token, secret)).resolves.toEqual({
      userId: '10000000-0000-4000-8000-000000000001',
      sessionId: '20000000-0000-4000-8000-000000000001',
    });
    expect(readBearerToken(`Bearer ${token}`)).toBe(token);
    expect(readWebSocketProtocolToken(`fanshuye.v1, bearer.${token}`)).toBe(token);
    expect(readWebSocketProtocolToken(`bearer.${token}`)).toBeUndefined();
    expect(
      readWebSocketProtocolToken(`fanshuye.v1, bearer.${token}, bearer.second-token`),
    ).toBeUndefined();
    expect(readWebSocketProtocolToken('fanshuye.v1, bearer.token with spaces')).toBeUndefined();
    expect(hashToken(token)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('allows native WebSockets without Origin and WebViews only from the exact allowlist', () => {
    const allowed = ['http://localhost:1420', 'tauri://localhost'];
    expect(isAllowedWebSocketOrigin(undefined, allowed)).toBe(true);
    expect(isAllowedWebSocketOrigin('tauri://localhost', allowed)).toBe(true);
    expect(isAllowedWebSocketOrigin('https://attacker.example', allowed)).toBe(false);
    expect(isAllowedWebSocketOrigin('tauri://localhost.attacker.example', allowed)).toBe(false);
  });

  it('accepts only explicit http(s) external references', () => {
    expect(isSafeExternalUrl('https://example.com/issues/1')).toBe(true);
    expect(isSafeExternalUrl('http://localhost:3000/task/1')).toBe(true);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalUrl('not a url')).toBe(false);
  });
});
