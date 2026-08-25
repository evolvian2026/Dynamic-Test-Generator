/** Central error handling: known errors keep their status, unknown ones don't leak. */

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, message, details);
export const unauthorized = (message = 'Authentication required') => new HttpError(401, message);
export const forbidden = (message = 'You do not have permission to perform this action') => new HttpError(403, message);
export const notFound = (message = 'Not found') => new HttpError(404, message);
export const conflict = (message, details) => new HttpError(409, message, details);
export const unprocessable = (message, details) => new HttpError(422, message, details);

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { message: `No route matches ${req.method} ${req.originalUrl}` } });
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
export function errorHandler(err, req, res, next) {
  const status = Number(err.status) || 500;

  if (status >= 500) {
    console.error('[error]', req.method, req.originalUrl, err);
  }

  // Zod validation failures arrive with an `issues` array.
  if (err?.issues) {
    return res.status(400).json({
      error: {
        message: 'The request body failed validation.',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }

  res.status(status).json({
    error: {
      message: status >= 500 ? 'An unexpected server error occurred.' : err.message,
      ...(err.details ? { details: err.details } : {}),
    },
  });
}
