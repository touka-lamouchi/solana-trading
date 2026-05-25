// Security audit trail (OWASP A09 — Security Logging & Monitoring Failures).
//
// Emits structured, tamper-evident-ish security events on a dedicated logger
// channel so auth attempts, ownership violations, and state changes (start/stop/
// config) are queryable separately from operational noise. NEVER log secrets,
// signatures, or private keys here.

import { logger } from "../utils/logger";

export type AuditEvent =
  | "auth_success"
  | "auth_failed"
  | "access_denied"
  | "bot_started"
  | "bot_stopped"
  | "config_changed"
  | "test_opportunity";

export function auditLog(event: AuditEvent, meta: Record<string, unknown>): void {
  logger.info({ audit: true, event, ...sanitize(meta), ts: new Date().toISOString() }, `[AUDIT] ${event}`);
}

// Defense-in-depth: strip anything that looks like a secret even if a caller
// accidentally passes it in.
const SECRET_KEYS = ["signature", "token", "secret", "privateKey", "secretKey", "password"];
function sanitize(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = SECRET_KEYS.some((s) => k.toLowerCase().includes(s.toLowerCase())) ? "[redacted]" : v;
  }
  return out;
}
