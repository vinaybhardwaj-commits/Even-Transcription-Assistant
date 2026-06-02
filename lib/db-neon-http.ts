import { neon, neonConfig, type NeonQueryFunction } from '@neondatabase/serverless';

neonConfig.fetchConnectionCache = true;

// Lazy init (B19 P2): construct the Neon client on first use, not at import,
// so the build/import never crashes when DATABASE_URL is unset. Mirrors lib/db.ts.
let _sql: NeonQueryFunction<false, false> | null = null;
function getSql(): NeonQueryFunction<false, false> {
  if (!_sql) _sql = neon(process.env.DATABASE_URL || process.env.APP_DATABASE_URL || "");
  return _sql;
}
export const sql: NeonQueryFunction<false, false> = new Proxy(
  (() => {}) as unknown as NeonQueryFunction<false, false>,
  {
    apply: (_t, _this, args) => (getSql() as unknown as (...a: unknown[]) => unknown)(...args),
    get: (_t, prop) => (getSql() as unknown as Record<string | symbol, unknown>)[prop],
  }
) as NeonQueryFunction<false, false>;

export type Chunk = {
  id: number;
  source: string;
  book: string;
  chapter: string | null;
  section: string | null;
  page_start: number | null;
  page_end: number | null;
  item_number: string | null;
  chunk_type: 'narrative' | 'explanation' | string;
  text: string;
  token_count: number | null;
};

export type ChunkHit = Chunk & { similarity: number };
