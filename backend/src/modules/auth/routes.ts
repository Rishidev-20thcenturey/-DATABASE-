import { Router, type CookieOptions, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import { corsOrigins } from '../../config/env.js';
import { authenticate, currentUser } from '../../middleware/auth.js';
import { createAuthRateLimit } from '../../middleware/rate-limit.js';
import { input, validate } from '../../middleware/validate.js';
import { forbidden, notFound, unauthorized } from '../../utils/errors.js';
import { sendData } from '../../utils/http.js';
import * as service from './service.js';

export const REFRESH_COOKIE = 'refresh_token';
export const REFRESH_PATH = '/api/v1/auth';

const registerSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(254),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters.')
      // bcrypt only uses the first 72 bytes; reject longer passwords rather than silently truncating.
      .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, 'Password must be at most 72 bytes.'),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9]{10,15}$/, 'Phone must be 10 to 15 digits.')
      .optional(),
  })
  .strict();

const loginSchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string().min(1).max(72),
  })
  .strict();

function refreshCookieOptions(env: Env): CookieOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    path: REFRESH_PATH,
  };
}

function setRefreshCookie(res: Response, env: Env, token: string, expiresAt: Date) {
  res.cookie(REFRESH_COOKIE, token, { ...refreshCookieOptions(env), expires: expiresAt });
}

/**
 * CSRF defence for cookie-authenticated endpoints. Browsers always send Origin on cross-origin
 * POSTs, so a foreign Origin is rejected. Non-browser clients without an Origin header are allowed.
 */
function assertTrustedOrigin(req: Request, env: Env) {
  const origin = req.header('origin');
  if (origin && !corsOrigins(env).includes(origin)) {
    throw forbidden('Requests to this endpoint must come from an allowed origin.');
  }
}

export function authRouter(env: Env): Router {
  const router = Router();
  const authRateLimit = createAuthRateLimit(env.AUTH_RATE_LIMIT_MAX);
  const config = {
    jwtSecret: env.JWT_ACCESS_SECRET,
    accessTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
    refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
  };

  router.post('/register', authRateLimit, validate('body', registerSchema), async (req, res) => {
    const body = input<typeof registerSchema>(req, 'body');
    const session = await service.registerCustomer(body, config);
    setRefreshCookie(res, env, session.refreshToken, session.refreshExpiresAt);
    sendData(res, toSessionResponse(session), 201);
  });

  router.post('/login', authRateLimit, validate('body', loginSchema), async (req, res) => {
    const body = input<typeof loginSchema>(req, 'body');
    const session = await service.login(body.email, body.password, config);
    setRefreshCookie(res, env, session.refreshToken, session.refreshExpiresAt);
    sendData(res, toSessionResponse(session));
  });

  router.post('/refresh', async (req, res) => {
    assertTrustedOrigin(req, env);
    const token = req.cookies?.[REFRESH_COOKIE];
    if (typeof token !== 'string' || token.length === 0) {
      res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(env));
      // Same error shape as an invalid token so the frontend handles both identically.
      throw unauthorized('Your session is invalid or has expired.', 'REFRESH_TOKEN_INVALID');
    }
    try {
      const session = await service.refreshSession(token, config);
      setRefreshCookie(res, env, session.refreshToken, session.refreshExpiresAt);
      sendData(res, toSessionResponse(session));
    } catch (error) {
      res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(env));
      throw error;
    }
  });

  router.post('/logout', async (req, res) => {
    assertTrustedOrigin(req, env);
    const token = req.cookies?.[REFRESH_COOKIE];
    if (typeof token === 'string' && token.length > 0) {
      await service.revokeRefreshToken(token);
    }
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(env));
    res.status(204).end();
  });

  router.get('/me', authenticate, async (req, res) => {
    const user = await service.getUserById(currentUser(req).id);
    if (!user) throw notFound('User');
    sendData(res, user);
  });

  return router;
}

function toSessionResponse(session: service.Session) {
  return {
    accessToken: session.accessToken,
    tokenType: 'Bearer' as const,
    expiresIn: session.expiresIn,
    user: session.user,
  };
}
