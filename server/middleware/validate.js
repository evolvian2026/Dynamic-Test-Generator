/** Zod-backed request validation. Replaces req.body/query with parsed data. */

export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) return next(result.error);
    req.body = result.data;
    next();
  };
}

export function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) return next(result.error);
    // Express 5 exposes req.query via a getter; keep parsed data alongside it.
    req.validatedQuery = result.data;
    next();
  };
}
