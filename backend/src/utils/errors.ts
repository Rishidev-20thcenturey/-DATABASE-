export type ErrorDetail = { field?: string; message: string; [key: string]: unknown };

/** Application error with a stable, machine-readable `code` that the frontend can rely on. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: ErrorDetail[] = [],
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details: ErrorDetail[] = []) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication is required.', code = 'UNAUTHENTICATED') =>
  new AppError(401, code, message);
export const forbidden = (message = 'You do not have permission to perform this action.') =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (resource = 'Resource') => new AppError(404, 'NOT_FOUND', `${resource} was not found.`);
export const conflict = (code: string, message: string, details: ErrorDetail[] = []) =>
  new AppError(409, code, message, details);
export const tooManyRequests = (message = 'Too many requests. Please try again later.') =>
  new AppError(429, 'RATE_LIMITED', message);
