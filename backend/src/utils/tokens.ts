import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Role } from '../types/domain.js';

export interface AccessTokenClaims {
  sub: string;
  role: Role;
}

export function signAccessToken(claims: AccessTokenClaims, secret: string, ttlSeconds: number): string {
  return jwt.sign({ role: claims.role }, secret, {
    subject: claims.sub,
    expiresIn: ttlSeconds,
    algorithm: 'HS256',
    issuer: 'food-delivery-api',
    audience: 'food-delivery-web',
  });
}

export function verifyAccessToken(token: string, secret: string): AccessTokenClaims {
  const decoded = jwt.verify(token, secret, {
    algorithms: ['HS256'],
    issuer: 'food-delivery-api',
    audience: 'food-delivery-web',
  }) as jwt.JwtPayload;
  if (typeof decoded.sub !== 'string' || typeof decoded.role !== 'string') {
    throw new Error('Malformed access token');
  }
  return { sub: decoded.sub, role: decoded.role as Role };
}

/** Opaque refresh token. Only its SHA-256 hash is stored in the database. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
