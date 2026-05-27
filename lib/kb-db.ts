/**
 * Knowledge-base database client.
 *
 * Separate from lib/db.ts (which talks to APP_DATABASE_URL — encounters,
 * doctors, send_events). KB lives in V's existing CDMSS Neon project,
 * shared with the Even-Staff-Portal app, and contains the MKSAP
 * embeddings + chunks. Read-only from ETA's perspective.
 *
 * Env: KB_DATABASE_URL (Sprint 0 set this to V's CDMSS DATABASE_URL).
 */

import { neon } from "@neondatabase/serverless";
import type { NeonQueryFunction } from "@neondatabase/serverless";

let _sql: NeonQueryFunction<false, false> | null = null;

export function kbSql(): NeonQueryFunction<false, false> {
  if (_sql) return _sql;
  const url = process.env.KB_DATABASE_URL;
  if (!url) {
    throw new Error("KB_DATABASE_URL not set");
  }
  _sql = neon(url);
  return _sql;
}

export type KbChunk = {
  id: number;
  source: string | null;
  book: string | null;
  chapter: string | null;
  section: string | null;
  page_start: number | null;
  page_end: number | null;
  item_number: string | null;
  chunk_type: string | null;
  text: string;
  token_count: number | null;
};

export type KbChunkHit = KbChunk & { similarity: number };
