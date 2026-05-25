// Zod request-body validation middleware (OWASP A03 — Injection / Insecure Design).
// Rejects malformed bodies with 400 before they reach any handler or Redis.

import { Request, Response, NextFunction } from "express";
import { ZodType } from "zod";

export function validateBody<T>(schema: ZodType<T>) {
  return function (req: Request, res: Response, next: NextFunction) {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: result.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    // Replace body with the parsed (stripped/coerced) value.
    req.body = result.data;
    next();
  };
}
