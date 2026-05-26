/**
 * lib/db.ts — APP_DATABASE access for Even Transcription Assistant.
 *
 * Uses the Neon HTTP driver via @neondatabase/serverless. Two exports:
 *   - db   — drizzle ORM instance for type-safe queries (preferred)
 *   - sql  — raw template tag for ad-hoc SQL (use sparingly; trace.ts uses it)
 *
 * Lazy initialization: the Neon client is constructed on first use, not at
 * module load. This lets the Next.js build succeed without APP_DATABASE_URL
 * set — runtime calls throw, which /api/health captures as a degraded probe.
 *
 * Pool-style imports (from lifted OPD code) should be migrated to use
 * the drizzle "db" export. See Sprint 1+ adaptation notes in build plan.
 */

import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import * as schema from "../db/schema";

let _sql: NeonQueryFunction<false, false> | null = null;
let _db: NeonHttpDatabase<typeof schema> | null = null;

function init(): void {
  if (_sql) return;
  const url = process.env.APP_DATABASE_URL;
  if (!url) {
    throw new Error(
      "APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2)."
    );
  }
  _sql = neon(url);
  _db = drizzle(_sql, { schema });
}

// Proxy that initializes on first call. Supports both template-tag and
// function-call invocation patterns (matches @neondatabase/serverless API).
export const sql: NeonQueryFunction<false, false> = new Proxy(
  (() => {}) as unknown as NeonQueryFunction<false, false>,
  {
    apply(_target, _thisArg, args) {
      init();
      // _sql is non-null after init()
      return (_sql as unknown as (...a: unknown[]) => unknown)(...args);
    },
    get(_target, prop) {
      init();
      return (_sql as unknown as Record<string | symbol, unknown>)[prop];
    },
  }
) as NeonQueryFunction<false, false>;

export const db: NeonHttpDatabase<typeof schema> = new Proxy(
  {} as NeonHttpDatabase<typeof schema>,
  {
    get(_target, prop) {
      init();
      return (_db as unknown as Record<string | symbol, unknown>)[prop];
    },
  }
);

export { schema };
