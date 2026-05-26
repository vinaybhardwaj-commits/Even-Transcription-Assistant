/**
 * lib/db.ts — APP_DATABASE access for Even Transcription Assistant.
 *
 * Uses the Neon HTTP driver via @neondatabase/serverless. Two exports:
 *   - db   — drizzle ORM instance for type-safe queries (preferred)
 *   - sql  — raw template tag for ad-hoc SQL (use sparingly; trace.ts uses it)
 *
 * Pool-style imports (from lifted OPD code) should be migrated to use
 * the drizzle "db" export. See Sprint 1+ adaptation notes in build plan.
 */

import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "../db/schema";

const url = process.env.APP_DATABASE_URL;
if (!url) {
  // Allow build-time imports without crashing; throw at first query attempt.
  console.warn("[db] APP_DATABASE_URL not set — queries will throw");
}

export const sql = neon(url ?? "postgres://invalid");
export const db = drizzle(sql, { schema });
export { schema };
