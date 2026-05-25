// Express auth middleware.
//
//   authenticate  — validates the `Authorization: Bearer <jwt>` header, attaches
//                   req.auth = { pubkey, role }. 401 if missing/invalid.
//   requireOwner  — ensures req.auth.pubkey === req.params.userId (or role=admin).
//                   This is the OWASP A01 / IDOR fix: a user can only act on their
//                   own resources.
//
// DEVNET BYPASS: when settings `auth.enabled` is false, both middlewares become
// no-ops that synthesize req.auth from the :userId param. This preserves the
// existing "bot wallet for every user" devnet flow and keeps test scripts working
// without tokens. Production MUST set auth.enabled: true.

import { Request, Response, NextFunction } from "express";
import { verifyToken, JwtPayload } from "../auth/siws";
import { logger } from "../../utils/logger";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: JwtPayload;
    }
  }
}

export interface AuthOptions {
  enabled: boolean;
}

export function makeAuthenticate(opts: AuthOptions) {
  return function authenticate(req: Request, res: Response, next: NextFunction) {
    if (!opts.enabled) {
      // Devnet bypass: trust the :userId param as identity.
      const userId = (req.params as Record<string, string>)["userId"];
      req.auth = { sub: userId ?? "__devnet__", role: "user" };
      return next();
    }

    const header = req.headers.authorization ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) {
      res.status(401).json({ error: "Missing bearer token" });
      return;
    }
    const payload = verifyToken(token);
    if (!payload) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }
    req.auth = payload;
    next();
  };
}

export function makeRequireOwner(opts: AuthOptions) {
  return function requireOwner(req: Request, res: Response, next: NextFunction) {
    if (!opts.enabled) return next(); // devnet bypass

    const { userId } = req.params;
    if (!req.auth) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    if (req.auth.role === "admin") return next();
    if (req.auth.sub !== userId) {
      logger.warn(
        { caller: req.auth.sub, target: userId, path: req.path },
        "Access denied: ownership mismatch (IDOR attempt)"
      );
      res.status(403).json({ error: "Forbidden: you can only access your own resources" });
      return;
    }
    next();
  };
}
