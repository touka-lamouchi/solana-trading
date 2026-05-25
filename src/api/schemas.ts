// Zod schemas for request bodies (OWASP A03 — Injection / A04 — Insecure Design).
// All fields optional+strict so a config POST is a partial update but unknown
// keys are rejected rather than silently merged into Redis.

import { z } from "zod";

const hhmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM (24h)");

export const ConfigUpdateSchema = z
  .object({
    dailyLimitUsd: z.number().nonnegative().max(1_000_000).optional(),
    maxTradeUsd: z.number().nonnegative().max(1_000_000).optional(),
    tradingHoursStart: hhmm.optional(),
    tradingHoursEnd: hhmm.optional(),
    enabledStrategies: z.array(z.string().max(40)).max(20).optional(),
    flashLoans: z.boolean().optional(),
    yieldGaps: z.boolean().optional(),
    liquidations: z.boolean().optional(),
    chartPatterns: z.boolean().optional(),
    socialBuzz: z.boolean().optional(),
    copyWhales: z.boolean().optional(),
    useVaultArb: z.boolean().optional(),
    useVaultFlashArb: z.boolean().optional(),
    minProfitMultiplier: z.number().min(1).max(100).optional(),
    mode: z.enum(["active", "viewer"]).optional(),
    aiWeights: z
      .object({
        chart: z.number().min(0).max(100),
        social: z.number().min(0).max(100),
        whale: z.number().min(0).max(100),
      })
      .optional(),
    aiConfidenceThreshold: z.number().min(0).max(1).optional(),
  })
  .strict(); // reject unknown keys

export type ConfigUpdate = z.infer<typeof ConfigUpdateSchema>;

// A Solana mint is a base58 ed25519 pubkey: 32–44 base58 chars.
export const TestSlowOppSchema = z
  .object({
    mint: z
      .string()
      .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "must be a base58 mint address"),
    amountIn: z.number().positive().max(10_000_000).optional(),
  })
  .strict();

export type TestSlowOpp = z.infer<typeof TestSlowOppSchema>;
