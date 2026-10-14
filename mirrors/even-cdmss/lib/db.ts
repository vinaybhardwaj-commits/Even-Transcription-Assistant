import { neon, neonConfig } from '@neondatabase/serverless';

neonConfig.fetchConnectionCache = true;

// Marks rows written by THIS deployment in the shared Neon DB.
// Portal writes 'portal' (column default); CAT writes 'standalone'.
const APP_SOURCE = process.env.APP_SOURCE || 'standalone';

const STAMP_TABLES = new Set([
  'traces', 'trace_events', 'coaching_sessions', 'flashcards', 'user_queries',
]);

// Lazy connection: construct the neon client on first use, not at module load.
// This lets `next build` collect page data without DATABASE_URL present, and
// the portal's eager `neon(process.env.DATABASE_URL!)` is thereby improved on.
let _client: ReturnType<typeof neon> | null = null;
function client(): ReturnType<typeof neon> {
  if (!_client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    _client = neon(url);
  }
  return _client;
}

/** Auto-inject app_source into INSERTs on the five shared usage tables. */
function injectAppSource(query: string, params: unknown[]): { query: string; params: unknown[] } {
  const m = query.match(/INSERT\s+INTO\s+(\w+)\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)/i);
  if (!m) return { query, params };
  if (!STAMP_TABLES.has(m[1].toLowerCase())) return { query, params };
  if (/\bapp_source\b/i.test(m[2])) return { query, params }; // already stamped
  // The VALUES capture is non-greedy and stops at the first ')'. If the values
  // contain a nested paren (a subquery or a function call like MAX()/NOW()),
  // appending here would produce corrupt SQL. Bail and let the column DEFAULT
  // apply — callers that need a specific app_source must include it explicitly.
  if (m[3].includes('(')) return { query, params };
  const nums = [...m[3].matchAll(/\$(\d+)/g)].map((x) => Number(x[1]));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  const newCols = m[2].replace(/\s*$/, '') + ', app_source';
  const newVals = m[3].replace(/\s*$/, '') + `, $${next}`;
  const newQuery = query.replace(m[0], `INSERT INTO ${m[1]} (${newCols}) VALUES (${newVals})`);
  return { query: newQuery, params: [...params, APP_SOURCE] };
}

/**
 * Drop-in replacement for the neon() client. Supports both call styles used in
 * the codebase: tagged-template `sql\`...\`` and parameterized `sql(text, params)`.
 * Only the parameterized form carries INSERTs we need to stamp.
 */
export const sql: ReturnType<typeof neon> = new Proxy((() => {}) as unknown as ReturnType<typeof neon>, {
  apply(_target, _thisArg, args: unknown[]) {
    const c = client() as unknown as (...a: unknown[]) => unknown;
    // Parameterized form: (queryString, paramsArray)
    if (typeof args[0] === 'string' && Array.isArray(args[1])) {
      const { query, params } = injectAppSource(args[0] as string, args[1] as unknown[]);
      return (c as (q: string, p: unknown[]) => unknown)(query, params);
    }
    // Tagged-template or other forms: pass through untouched.
    return c(...args);
  },
}) as ReturnType<typeof neon>;

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
