import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface AccessTokenClaims {
  userId: string;
  sessionId: string;
}

export async function signAccessToken(
  claims: AccessTokenClaims,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ sid: claims.sessionId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(new TextEncoder().encode(secret));
}

export async function verifyAccessToken(token: string, secret: string): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ['HS256'],
  });
  if (!payload.sub || typeof payload.sid !== 'string') {
    throw new Error('Access token is missing required claims');
  }
  return { userId: payload.sub, sessionId: payload.sid };
}

export function readBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+([^\s]+)$/i.exec(header);
  return match?.[1];
}

export function readWebSocketProtocolToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const protocols = header
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!protocols.includes('fanshuye.v1')) return undefined;
  const bearerProtocols = protocols.filter((value) => value.startsWith('bearer.'));
  if (bearerProtocols.length !== 1) return undefined;
  const token = bearerProtocols[0]?.slice('bearer.'.length);
  if (!token || token.length > 4_096 || !/^[A-Za-z0-9._~-]+$/.test(token)) return undefined;
  return token;
}

export function isAllowedWebSocketOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  // Native clients do not necessarily send Origin. Browser/WebView clients do,
  // and must match the same exact allowlist used for REST CORS.
  return origin === undefined || allowedOrigins.includes(origin);
}

export function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}
