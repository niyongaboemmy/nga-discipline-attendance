import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

/** Express middleware factory: parse+validate `req.body` against a Zod schema,
 *  replacing it with the parsed (typed, defaulted) value on success, or
 *  responding 400 with a readable message on failure. One shared shape for
 *  request validation instead of hand-rolled length/regex checks per route. */
export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: formatZodError(result.error),
      });
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: formatZodError(result.error),
      });
    }
    (req as any).validatedQuery = result.data;
    next();
  };
}

function formatZodError(error: ZodError): string {
  const first = error.issues[0];
  if (!first) return 'Invalid request.';
  const path = first.path.join('.');
  return path ? `${path}: ${first.message}` : first.message;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
