import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, closeDb, PASSWORD, registerCustomer, request, resetDatabase } from './helpers.js';

function refreshCookie(res: request.Response): string | undefined {
  const cookies = res.headers['set-cookie'] as unknown as string[] | undefined;
  return cookies?.find((c) => c.startsWith('refresh_token='));
}

describe('authentication', () => {
  beforeAll(async () => {
    await resetDatabase();
  });
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closeDb();
  });

  it('registers a customer, sets an HttpOnly refresh cookie, and returns an access token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Asha', email: '  Asha@Example.test ', password: PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.user.email).toBe('asha@example.test');
    expect(res.body.data.user.role).toBe('CUSTOMER');
    expect(res.body.data).not.toHaveProperty('refreshToken');
    expect(res.body.data.user).not.toHaveProperty('password_hash');

    const cookie = refreshCookie(res);
    expect(cookie).toBeDefined();
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/api/v1/auth');
  });

  it('cannot escalate role during public registration', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Mallory', email: 'mallory@example.test', password: PASSWORD, role: 'ADMIN' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects duplicate registration with a stable code', async () => {
    await registerCustomer();
    const first = await request(app).post('/api/v1/auth/register').send({ name: 'A', email: 'dup@example.test', password: PASSWORD });
    const second = await request(app).post('/api/v1/auth/register').send({ name: 'B', email: 'DUP@example.test', password: PASSWORD });
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('validates password length and bcrypt byte limit', async () => {
    const short = await request(app).post('/api/v1/auth/register').send({ name: 'A', email: 'short@example.test', password: 'abc' });
    expect(short.status).toBe(400);

    const long = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'A', email: 'long@example.test', password: 'a'.repeat(73) });
    expect(long.status).toBe(400);
  });

  it('logs in with valid credentials and rejects invalid ones with the same error', async () => {
    const { email } = await registerCustomer();

    const ok = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.data.tokenType).toBe('Bearer');

    const wrongPassword = await request(app).post('/api/v1/auth/login').send({ email, password: 'wrong-password-123' });
    const unknownEmail = await request(app).post('/api/v1/auth/login').send({ email: 'nobody@example.test', password: PASSWORD });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknownEmail.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
  });

  it('returns the current user from /auth/me and rejects missing or invalid tokens', async () => {
    const { token, email } = await registerCustomer();

    const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.data.email).toBe(email);

    const missing = await request(app).get('/api/v1/auth/me');
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('UNAUTHENTICATED');

    const garbage = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer not-a-jwt');
    expect(garbage.status).toBe(401);
    expect(garbage.body.error.code).toBe('TOKEN_INVALID');
  });

  it('rotates refresh tokens and rejects the old one when it is reused', async () => {
    const register = await registerCustomer();
    const first = await request(app).post('/api/v1/auth/login').send({ email: register.email, password: PASSWORD });
    const cookieA = refreshCookie(first)!;

    const refreshed = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieA);
    expect(refreshed.status).toBe(200);
    const cookieB = refreshCookie(refreshed)!;
    expect(cookieB).not.toBe(cookieA);

    // Presenting the already-rotated token is treated as theft: every session for the user is revoked.
    const reused = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieA);
    expect(reused.status).toBe(401);
    expect(reused.body.error.code).toBe('REFRESH_TOKEN_REUSED');

    const afterTheft = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieB);
    expect(afterTheft.status).toBe(401);
  });

  it('refresh fails without a cookie and logout revokes the session', async () => {
    const noCookie = await request(app).post('/api/v1/auth/refresh');
    expect(noCookie.status).toBe(401);
    expect(noCookie.body.error.code).toBe('REFRESH_TOKEN_INVALID');

    const { email } = await registerCustomer();
    const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    const cookie = refreshCookie(login)!;

    const logout = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie);
    expect(logout.status).toBe(204);

    const afterLogout = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(afterLogout.status).toBe(401);
  });

  it('refresh and logout reject requests from a disallowed Origin (CSRF defence)', async () => {
    const { email } = await registerCustomer();
    const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    const cookie = refreshCookie(login)!;

    const refresh = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example');
    expect(refresh.status).toBe(403);

    const logout = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie).set('Origin', 'https://evil.example');
    expect(logout.status).toBe(403);

    const allowed = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie).set('Origin', 'http://localhost:5173');
    expect(allowed.status).toBe(200);
  });

  it('does not grant CORS to unknown origins and allows the configured frontend origin', async () => {
    const allowed = await request(app).get('/api/v1/health').set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const denied = await request(app).get('/api/v1/health').set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('applies security headers and never leaks stack traces in errors', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.ts|stack/i);
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});
