import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config';
import { inTransaction, type DatabaseClient, type DatabasePool } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import {
  hashToken,
  randomToken,
  readBearerToken,
  readWebSocketProtocolToken,
  signAccessToken,
  verifyAccessToken,
} from '../../lib/security';
import type { AuthContext } from '../common/auth-context';
import type { EventHub } from '../sync/event-hub';
import type { VerificationEmailSender } from './email';
import { hashPassword, verifyPassword } from './password';

export type { AuthContext } from '../common/auth-context';

export interface SessionTokens {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresInSeconds: number;
  refreshTokenExpiresAt: string;
  user: { id: string; email: string; displayName: string };
}

export class AuthService {
  public constructor(
    private readonly pool: DatabasePool,
    private readonly config: AppConfig,
    private readonly eventHub: EventHub,
    private readonly verificationEmailSender?: VerificationEmailSender,
  ) {}

  async register(input: {
    email: string;
    displayName: string;
    password: string;
  }): Promise<{ userId: string; verificationRequired: true; verificationToken: string | null }> {
    const normalizedEmail = input.email.trim().toLowerCase();
    const passwordHash = await hashPassword(input.password);
    const verificationToken = randomToken();
    const verificationHash = hashToken(verificationToken);
    const verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);

    try {
      const userId = await inTransaction(this.pool, async (client) => {
        const user = await client.query<{ id: string }>(
          `INSERT INTO users(email, display_name) VALUES ($1, $2) RETURNING id`,
          [normalizedEmail, input.displayName.trim()],
        );
        const id = user.rows[0]?.id;
        if (!id) throw new Error('User creation did not return an id');
        await client.query(
          `INSERT INTO password_credentials(user_id, password_hash) VALUES ($1, $2)`,
          [id, passwordHash],
        );
        await client.query(
          `INSERT INTO email_verification_tokens(user_id, token_hash, expires_at)
           VALUES ($1, $2, $3)`,
          [id, verificationHash, verificationExpiresAt],
        );
        await this.verificationEmailSender?.sendVerificationEmail({
          email: normalizedEmail,
          displayName: input.displayName.trim(),
          token: verificationToken,
          expiresAt: verificationExpiresAt,
        });
        return id;
      });
      return {
        userId,
        verificationRequired: true,
        verificationToken:
          this.config.NODE_ENV === 'production' || this.verificationEmailSender
            ? null
            : verificationToken,
      };
    } catch (error) {
      if (isPgUniqueViolation(error)) {
        throw new ApiError(409, 'VALIDATION_ERROR', 'An account already exists for this email');
      }
      throw error;
    }
  }

  async verifyEmail(token: string): Promise<void> {
    const tokenHash = hashToken(token);
    const changed = await inTransaction(this.pool, async (client) => {
      const result = await client.query<{ user_id: string }>(
        `UPDATE email_verification_tokens
            SET consumed_at = clock_timestamp()
          WHERE token_hash = $1
            AND consumed_at IS NULL
            AND expires_at > clock_timestamp()
          RETURNING user_id`,
        [tokenHash],
      );
      const userId = result.rows[0]?.user_id;
      if (!userId) return false;
      await client.query(
        `UPDATE users SET email_verified_at = COALESCE(email_verified_at, clock_timestamp()) WHERE id = $1`,
        [userId],
      );
      return true;
    });
    if (!changed)
      throw new ApiError(400, 'VALIDATION_ERROR', 'Verification token is invalid or expired');
  }

  async login(input: {
    email: string;
    password: string;
    userAgent: string | null;
    ipAddress: string | null;
  }): Promise<SessionTokens> {
    const result = await this.pool.query<{
      id: string;
      email: string;
      display_name: string;
      email_verified_at: Date | null;
      password_hash: string;
    }>(
      `SELECT u.id, u.email::text, u.display_name, u.email_verified_at, p.password_hash
         FROM users u
         JOIN password_credentials p ON p.user_id = u.id
        WHERE u.email = $1`,
      [input.email.trim().toLowerCase()],
    );
    const user = result.rows[0];
    const passwordMatches = await verifyPassword(user?.password_hash, input.password);
    if (!user || !passwordMatches) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }
    if (!user.email_verified_at) {
      throw new ApiError(403, 'EMAIL_NOT_VERIFIED', 'Verify the email address before signing in');
    }
    return inTransaction(this.pool, (client) =>
      this.createSession(client, user, input.userAgent, input.ipAddress),
    );
  }

  async refresh(refreshToken: string): Promise<SessionTokens> {
    const refreshHash = hashToken(refreshToken);
    return inTransaction(this.pool, async (client) => {
      const result = await client.query<{
        session_id: string;
        user_id: string;
        email: string;
        display_name: string;
      }>(
        `SELECT s.id AS session_id, u.id AS user_id, u.email::text, u.display_name
           FROM sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.refresh_token_hash = $1
            AND s.revoked_at IS NULL
            AND s.expires_at > clock_timestamp()
            AND u.email_verified_at IS NOT NULL
          FOR UPDATE OF s`,
        [refreshHash],
      );
      const row = result.rows[0];
      if (!row)
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Refresh token is invalid or expired');

      const rotatedToken = randomToken(48);
      const expiresAt = new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
      await client.query(
        `UPDATE sessions
            SET refresh_token_hash = $2, expires_at = $3, last_seen_at = clock_timestamp()
          WHERE id = $1`,
        [row.session_id, hashToken(rotatedToken), expiresAt],
      );
      const accessToken = await signAccessToken(
        { userId: row.user_id, sessionId: row.session_id },
        this.config.SESSION_SECRET,
        this.config.ACCESS_TOKEN_TTL_SECONDS,
      );
      return {
        sessionId: row.session_id,
        accessToken,
        refreshToken: rotatedToken,
        accessTokenExpiresInSeconds: this.config.ACCESS_TOKEN_TTL_SECONDS,
        refreshTokenExpiresAt: expiresAt.toISOString(),
        user: { id: row.user_id, email: row.email, displayName: row.display_name },
      };
    });
  }

  async authenticateRequest(request: FastifyRequest): Promise<AuthContext> {
    const token = readBearerToken(request.headers.authorization);
    if (!token)
      throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'A bearer access token is required');

    return this.authenticateToken(token);
  }

  async authenticateWebSocketRequest(request: FastifyRequest): Promise<AuthContext> {
    const protocolHeader = request.headers['sec-websocket-protocol'];
    const token = readWebSocketProtocolToken(
      typeof protocolHeader === 'string' ? protocolHeader : undefined,
    );
    if (!token) {
      throw new ApiError(
        401,
        'AUTHENTICATION_REQUIRED',
        'The fanshuye.v1 WebSocket protocol and bearer token are required',
      );
    }

    return this.authenticateToken(token);
  }

  private async authenticateToken(token: string): Promise<AuthContext> {
    let claims: { userId: string; sessionId: string };
    try {
      claims = await verifyAccessToken(token, this.config.SESSION_SECRET);
    } catch {
      throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Access token is invalid or expired');
    }

    const result = await this.pool.query<{
      user_id: string;
      email: string;
      display_name: string;
    }>(
      `SELECT u.id AS user_id, u.email::text, u.display_name
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.user_id = $2
          AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
          AND u.email_verified_at IS NOT NULL`,
      [claims.sessionId, claims.userId],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Session is no longer active');
    return {
      userId: row.user_id,
      sessionId: claims.sessionId,
      email: row.email,
      displayName: row.display_name,
    };
  }

  async logout(auth: AuthContext): Promise<void> {
    await this.revokeSession(auth, auth.sessionId);
  }

  async revokeSession(auth: AuthContext, sessionId: string): Promise<void> {
    const result = await this.pool.query<{ id: string }>(
      `UPDATE sessions
          SET revoked_at = COALESCE(revoked_at, clock_timestamp())
        WHERE id = $1 AND user_id = $2
        RETURNING id`,
      [sessionId, auth.userId],
    );
    if (!result.rowCount) {
      throw new ApiError(404, 'NOT_FOUND', 'Session is not available');
    }
    this.eventHub.disconnectSession(sessionId);
  }

  private async createSession(
    client: DatabaseClient,
    user: { id: string; email: string; display_name: string },
    userAgent: string | null,
    ipAddress: string | null,
  ): Promise<SessionTokens> {
    const refreshToken = randomToken(48);
    const expiresAt = new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    const result = await client.query<{ id: string }>(
      `INSERT INTO sessions(user_id, refresh_token_hash, expires_at, user_agent, ip_address)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [user.id, hashToken(refreshToken), expiresAt, userAgent, ipAddress],
    );
    const sessionId = result.rows[0]?.id;
    if (!sessionId) throw new Error('Session creation did not return an id');
    const accessToken = await signAccessToken(
      { userId: user.id, sessionId },
      this.config.SESSION_SECRET,
      this.config.ACCESS_TOKEN_TTL_SECONDS,
    );
    return {
      sessionId,
      accessToken,
      refreshToken,
      accessTokenExpiresInSeconds: this.config.ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenExpiresAt: expiresAt.toISOString(),
      user: { id: user.id, email: user.email, displayName: user.display_name },
    };
  }
}

function isPgUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
