import type { NextFunction, Request, Response } from 'express';
import { query } from '../db/pool.js';
import type { AuthUser, Role } from '../types/domain.js';
import { forbidden, unauthorized } from '../utils/errors.js';
import { verifyAccessToken } from '../utils/tokens.js';

const AUTH = Symbol.for('app.authUser');
let jwtSecret: string | undefined;

export function configureAuth(secret: string): void {
  jwtSecret = secret;
}

/**
 * Verifies the Bearer access token, then re-reads the user from the database. This means role changes
 * and suspensions take effect immediately instead of waiting for the access token to expire.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || !jwtSecret) return next(unauthorized());

    let claims;
    try {
      claims = verifyAccessToken(match[1], jwtSecret);
    } catch {
      return next(unauthorized('Your session is invalid or has expired.', 'TOKEN_INVALID'));
    }

    const result = await query<{ id: string; role: Role; status: string }>(
      'SELECT id, role, status FROM users WHERE id = $1',
      [claims.sub],
    );
    const user = result.rows[0];
    if (!user) return next(unauthorized('Your session is invalid or has expired.', 'TOKEN_INVALID'));
    if (user.status !== 'ACTIVE') return next(forbidden('This account is suspended.'));

    (req as unknown as Record<symbol, AuthUser>)[AUTH] = { id: user.id, role: user.role };
    return next();
  } catch (error) {
    return next(error);
  }
}

/** Returns the authenticated user. Only valid after `authenticate` has run. */
export function currentUser(req: Request): AuthUser {
  const user = (req as unknown as Record<symbol, AuthUser | undefined>)[AUTH];
  if (!user) throw unauthorized();
  return user;
}

/** Restricts a route to the given roles. Must run after `authenticate`. */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = (req as unknown as Record<symbol, AuthUser | undefined>)[AUTH];
    if (!user) return next(unauthorized());
    if (!roles.includes(user.role)) return next(forbidden());
    return next();
  };
}
