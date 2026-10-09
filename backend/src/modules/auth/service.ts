import bcrypt from 'bcryptjs';
import { query, withTransaction } from '../../db/pool.js';
import type { Role } from '../../types/domain.js';
import { conflict, forbidden, unauthorized } from '../../utils/errors.js';
import { generateRefreshToken, hashToken, signAccessToken } from '../../utils/tokens.js';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: Role;
  status: string;
  createdAt: string;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  password_hash: string;
  role: Role;
  status: string;
  created_at: Date;
}

export const toPublicUser = (row: UserRow): PublicUser => ({
  id: row.id,
  name: row.name,
  email: row.email,
  phone: row.phone,
  role: row.role,
  status: row.status,
  createdAt: row.created_at.toISOString(),
});

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export interface AuthConfig {
  jwtSecret: string;
  accessTtlSeconds: number;
  refreshTtlDays: number;
}

export interface Session {
  accessToken: string;
  expiresIn: number;
  user: PublicUser;
  refreshToken: string;
  refreshExpiresAt: Date;
}

const BCRYPT_ROUNDS = 12;
// Used to keep login timing similar whether or not the email exists.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer-password', BCRYPT_ROUNDS);

async function issueSession(userRow: UserRow, config: AuthConfig): Promise<Session> {
  const refreshToken = generateRefreshToken();
  const refreshExpiresAt = new Date(Date.now() + config.refreshTtlDays * 24 * 60 * 60 * 1000);
  await query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userRow.id, hashToken(refreshToken), refreshExpiresAt],
  );
  return {
    accessToken: signAccessToken({ sub: userRow.id, role: userRow.role }, config.jwtSecret, config.accessTtlSeconds),
    expiresIn: config.accessTtlSeconds,
    user: toPublicUser(userRow),
    refreshToken,
    refreshExpiresAt,
  };
}

export async function registerCustomer(
  input: { name: string; email: string; password: string; phone?: string },
  config: AuthConfig,
): Promise<Session> {
  const email = normalizeEmail(input.email);
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  try {
    const result = await query<UserRow>(
      `INSERT INTO users (name, email, phone, password_hash, role)
       VALUES ($1, $2, $3, $4, 'CUSTOMER')
       RETURNING id, name, email, phone, password_hash, role, status, created_at`,
      [input.name.trim(), email, input.phone ?? null, passwordHash],
    );
    return issueSession(result.rows[0], config);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict('EMAIL_ALREADY_REGISTERED', 'An account with this email already exists.');
    }
    throw error;
  }
}

export async function login(email: string, password: string, config: AuthConfig): Promise<Session> {
  const result = await query<UserRow>(
    'SELECT id, name, email, phone, password_hash, role, status, created_at FROM users WHERE email = $1',
    [normalizeEmail(email)],
  );
  const user = result.rows[0];
  const passwordOk = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordOk) {
    throw unauthorized('The email or password is incorrect.', 'INVALID_CREDENTIALS');
  }
  if (user.status !== 'ACTIVE') throw forbidden('This account is suspended.');
  return issueSession(user, config);
}

/**
 * Rotates a refresh token: the presented token is revoked and a new one is issued.
 * Presenting an already-revoked token is treated as theft, so every session for that user is revoked.
 */
export async function refreshSession(presentedToken: string, config: AuthConfig): Promise<Session> {
  // Reuse is detected inside the transaction, but the revocation must be committed, not rolled back,
  // so the error is thrown only after the transaction has finished.
  const outcome = await withTransaction(async (client) => {
    const found = await client.query<{ id: string; user_id: string; expires_at: Date; revoked_at: Date | null }>(
      'SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE',
      [hashToken(presentedToken)],
    );
    const token = found.rows[0];
    if (!token) return { kind: 'invalid' as const };

    if (token.revoked_at) {
      await client.query(
        'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
        [token.user_id],
      );
      return { kind: 'reused' as const };
    }
    if (token.expires_at.getTime() <= Date.now()) {
      return { kind: 'expired' as const };
    }

    const userResult = await client.query<UserRow>(
      'SELECT id, name, email, phone, password_hash, role, status, created_at FROM users WHERE id = $1',
      [token.user_id],
    );
    const user = userResult.rows[0];
    if (!user) return { kind: 'invalid' as const };
    if (user.status !== 'ACTIVE') return { kind: 'suspended' as const };

    const newToken = generateRefreshToken();
    const refreshExpiresAt = new Date(Date.now() + config.refreshTtlDays * 24 * 60 * 60 * 1000);
    const inserted = await client.query<{ id: string }>(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING id',
      [user.id, hashToken(newToken), refreshExpiresAt],
    );
    await client.query(
      'UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1',
      [token.id, inserted.rows[0].id],
    );

    return {
      kind: 'ok' as const,
      session: {
        accessToken: signAccessToken({ sub: user.id, role: user.role }, config.jwtSecret, config.accessTtlSeconds),
        expiresIn: config.accessTtlSeconds,
        user: toPublicUser(user),
        refreshToken: newToken,
        refreshExpiresAt,
      },
    };
  });

  switch (outcome.kind) {
    case 'ok':
      return outcome.session;
    case 'reused':
      throw unauthorized('Your session was revoked. Please sign in again.', 'REFRESH_TOKEN_REUSED');
    case 'expired':
      throw unauthorized('Your session has expired. Please sign in again.', 'REFRESH_TOKEN_EXPIRED');
    case 'suspended':
      throw forbidden('This account is suspended.');
    case 'invalid':
      throw unauthorized('Your session is invalid or has expired.', 'REFRESH_TOKEN_INVALID');
  }
}

export async function revokeRefreshToken(presentedToken: string): Promise<void> {
  await query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashToken(presentedToken)],
  );
}

export async function getUserById(userId: string): Promise<PublicUser | null> {
  const result = await query<UserRow>(
    'SELECT id, name, email, phone, password_hash, role, status, created_at FROM users WHERE id = $1',
    [userId],
  );
  return result.rows[0] ? toPublicUser(result.rows[0]) : null;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}
