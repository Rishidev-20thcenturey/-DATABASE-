import rateLimit from 'express-rate-limit';

const standardHeaders = 'draft-7' as const;

/** Strict limit for login and registration to slow credential-stuffing and spam. */
export function createAuthRateLimit(max: number) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: max,
    standardHeaders,
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.', details: [] } },
  });
}

/** General limit for the whole API. */
export function createApiRateLimit(max: number) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: max,
    standardHeaders,
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.', details: [] } },
  });
}
