import type { NextFunction, Request, Response } from 'express';
import type { ZodType, z } from 'zod';
import { badRequest } from '../utils/errors.js';

type Source = 'body' | 'query' | 'params';
type ValidatedInput = Partial<Record<Source, unknown>>;

const INPUT = Symbol.for('app.validatedInput');

/**
 * Validates request data with a Zod schema. Parsed values (typed, trimmed, defaults applied) are stored
 * on the request and read back with `input(req, 'body')`, so handlers never see unvalidated data.
 */
export function validate<S extends ZodType>(source: Source, schema: S) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || source,
        message: issue.message,
      }));
      return next(badRequest('VALIDATION_ERROR', 'The request contains invalid fields.', details));
    }
    const holder = req as unknown as Record<symbol, ValidatedInput>;
    holder[INPUT] = { ...(holder[INPUT] ?? {}), [source]: result.data };
    return next();
  };
}

export function input<S extends ZodType>(req: Request, source: Source): z.infer<S> {
  const holder = req as unknown as Record<symbol, ValidatedInput>;
  return holder[INPUT]?.[source] as z.infer<S>;
}
