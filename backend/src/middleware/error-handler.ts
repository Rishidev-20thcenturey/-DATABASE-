import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/errors.js';
import { requestIdOf } from './request-id.js';

/** Converts every thrown error into the documented error envelope. Never leaks stack traces to clients. */
export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = requestIdOf(req);

  if (error instanceof AppError) {
    return res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details, requestId },
    });
  }

  // Malformed JSON bodies from express.json()
  if (typeof error === 'object' && error !== null && 'type' in error && (error as { type?: string }).type === 'entity.parse.failed') {
    return res.status(400).json({
      error: { code: 'MALFORMED_JSON', message: 'The request body is not valid JSON.', details: [], requestId },
    });
  }

  if (typeof error === 'object' && error !== null && 'type' in error && (error as { type?: string }).type === 'entity.too.large') {
    return res.status(413).json({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.', details: [], requestId },
    });
  }

  console.error(JSON.stringify({ level: 'error', requestId, message: (error as Error)?.message ?? 'unknown error' }));
  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', details: [], requestId },
  });
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `No route matches ${req.method} ${req.path}.`,
      details: [],
      requestId: requestIdOf(req),
    },
  });
}
