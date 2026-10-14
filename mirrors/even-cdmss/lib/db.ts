import { neon, neonConfig } from '@neondatabase/serverless';
// LAB-MCP-V2 §7 (decision 6): fail-closed. Production SQL is unreachable from inside a
// lab execution context — see the trap below.
import { labExecution, LabError } from './lab-execution-context';
import { opdLabWriteFenceActive, OpdLabWriteForbidden, tripOpdLabWriteFence } from './opd-lab-write-guard';

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

/** Test spy. Production leaves this null. `executed` is false when the write fence refuses the statement. */
let sqlSpy: ((statement: string, executed: boolean) => void) | null = null;
export function setSqlSpy(spy: ((statement: string, executed: boolean) => void) | null): void {
  sqlSpy = spy;
}

function statementText(args: unknown[]): string | null {
  const head = args[0];
  if (typeof head === 'string') return head;
  if (Array.isArray(head)) return (head as string[]).join(' ');
  return null;
}

/**
 * SELECT and WITH ... SELECT only. Anything else, including a CTE that writes,
 * a multi-statement script, or a call shape we cannot read, is a write.
 */
export function isProductionReadSql(sqlText: string): boolean {
  let s = sqlText.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  s = s.replace(/'(?:''|[^'])*'/g, "''").replace(/"(?:\\"|[^"])*"/g, '""');
  s = s.trim().replace(/;+\s*$/g, '');
  if (!s || s.includes(';')) return false;
  const lower = s.toLowerCase();
  if (!lower.startsWith('select') && !lower.startsWith('with')) return false;
  const body = lower
    .replace(/\bfor\s+update\b/g, ' ')
    .replace(/\bfor\s+share\b/g, ' ')
    .replace(/\bfor\s+no\s+key\s+update\b/g, ' ');
  return !/\b(insert|update|delete|merge|into|create|alter|drop|truncate|grant|revoke|copy|call|do|vacuum|refresh|reindex|lock|set|begin|commit|rollback)\b/.test(body);
}

/**
 * Drop-in replacement for the neon() client. Supports both call styles used in
 * the codebase: tagged-template `sql\`...\`` and parameterized `sql(text, params)`.
 * Only the parameterized form carries INSERTs we need to stamp.
 */
export const sql: ReturnType<typeof neon> = new Proxy((() => {}) as unknown as ReturnType<typeof neon>, {
  apply(_target, _thisArg, args: unknown[]) {
    const text = statementText(args);
    // Paired-audit fence: named writers throw first, and any other statement that is
    // not a read throws here. Checked before the lab-IO fence so a swallowed write
    // still sets the tripped bit.
    if (opdLabWriteFenceActive() && (text == null || !isProductionReadSql(text))) {
      sqlSpy?.(text ?? '', false);
      const err = new OpdLabWriteForbidden('sql');
      tripOpdLabWriteFence(err);
      throw err;
    }
    // §7 — THE fence. A research run executes production engine code, and that code
    // reaches for `sql` in a dozen places (the LVC rules, the doctor directory, every
    // store write). None of it may run: a research key must not be able to read an
    // identifying production row or write ANY production row, and it must not be able
    // to do so by accident. Throwing here is fail-closed by construction — a new call
    // site added years from now is guarded the day it is written, with no diff.
    if (labExecution()) throw new LabError('LAB_IO_FORBIDDEN', 'production sql inside lab execution');
    sqlSpy?.(text ?? '', true);
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
