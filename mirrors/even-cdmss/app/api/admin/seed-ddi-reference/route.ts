import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { norm } from '@/lib/ddi-reference';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Ingests DDInter 2.0 (CC BY-NC-SA 4.0 — ddinter.scbdd.com) into `ddi_reference`,
// server-side. Filters to drug pairs where BOTH drugs are in the EHRC formulary,
// and severity-gates to Major/Moderate (drops Minor/Unknown noise). Idempotent.
//
// Hardened fetch: SEQUENTIAL (DDInter throttles parallel grabs), long per-file
// timeout, retries with backoff, fast-skip on 404, and a wall-clock budget so the
// function returns cleanly even if some category files stay slow.
//
// Attribution: interaction data © DDInter 2.0, CC BY-NC-SA 4.0. NonCommercial —
// confirm licensing before production use.

const CSV_BASE = 'https://ddinter.scbdd.com/static/media/download/ddinter_downloads_code_';
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const KEEP = new Set(['Major', 'Moderate']);
const SPLIT = /\s*[+/&,]\s*|\band\b/;
const STOP = new Set(['acid', 'sodium', 'potassium', 'chloride', 'sulphate', 'sulfate', 'hydrochloride', 'hcl', 'human', 'calcium', 'magnesium', 'citrate', 'phosphate', 'bicarbonate', 'succinate', 'besylate', 'mesylate', 'maleate', 'tartrate', 'base', 'oil', 'gel']);

const DEADLINE_MS = 270_000;

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  const start = Date.now();
  const remaining = () => DEADLINE_MS - (Date.now() - start);

  async function fetchCsv(L: string): Promise<{ status: 'ok' | 'absent' | 'failed'; text?: string }> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (remaining() < 8000) return { status: 'failed' };
      const perTry = Math.min(60_000, remaining() - 2000);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), perTry);
      try {
        const r = await fetch(`${CSV_BASE}${L}.csv`, { signal: ctrl.signal });
        if (r.status === 404) { clearTimeout(timer); return { status: 'absent' }; }
        if (r.ok) { const text = await r.text(); clearTimeout(timer); return { status: 'ok', text }; }
        clearTimeout(timer);
      } catch { clearTimeout(timer); }
      if (attempt < 3 && remaining() > 4000) await new Promise((res) => setTimeout(res, 1000 * attempt));
    }
    return { status: 'failed' };
  }

  try {
    await sql`CREATE TABLE IF NOT EXISTS ddi_reference (
      id BIGSERIAL PRIMARY KEY, drug_a TEXT NOT NULL, drug_b TEXT NOT NULL,
      severity TEXT NOT NULL, source TEXT NOT NULL, mechanism TEXT, management TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS ddi_reference_a_idx ON ddi_reference (drug_a)`;
    await sql`CREATE INDEX IF NOT EXISTS ddi_reference_b_idx ON ddi_reference (drug_b)`;

    // EHRC formulary ingredient token set (split combination products).
    const frows = (await sql`SELECT generic_canon FROM formulary WHERE generic_canon <> ''`) as { generic_canon: string }[];
    const formTokens = new Set<string>();
    for (const r of frows) {
      for (const tok of norm(r.generic_canon).split(SPLIT)) {
        const t = tok.trim();
        if (t.length > 3 && !STOP.has(t)) formTokens.add(t);
      }
    }

    // Sequential fetch + parse; keep only formulary-matched Major/Moderate pairs.
    const pairs = new Map<string, { a: string; b: string; sev: string }>();
    const files: Record<string, string> = {};
    let scanned = 0, filesOk = 0;
    for (const L of LETTERS) {
      if (remaining() < 8000) { files[L] = 'skipped(time)'; continue; }
      const res = await fetchCsv(L);
      if (res.status !== 'ok' || !res.text) { if (res.status !== 'absent') files[L] = res.status; continue; }
      filesOk++;
      let kept = 0;
      const lines = res.text.split(/\r?\n/);
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const c = line.split(',');
        if (c.length !== 5) continue;
        scanned++;
        if (!KEEP.has(c[4].trim())) continue;
        const na = norm(c[1]); const nb = norm(c[3]);
        if (!na || !nb || na === nb) continue;
        if (!formTokens.has(na) || !formTokens.has(nb)) continue;
        const key = na < nb ? `${na}|${nb}` : `${nb}|${na}`;
        if (!pairs.has(key)) { pairs.set(key, { a: na, b: nb, sev: c[4].trim().toLowerCase() }); kept++; }
      }
      files[L] = `ok(${kept})`;
    }

    await sql`TRUNCATE ddi_reference RESTART IDENTITY`;
    const arr = [...pairs.values()];
    const B = 500; let inserted = 0;
    for (let i = 0; i < arr.length; i += B) {
      const c = arr.slice(i, i + B);
      await sql`
        INSERT INTO ddi_reference (drug_a, drug_b, severity, source)
        SELECT * FROM UNNEST(
          ${c.map((p) => p.a)}::text[], ${c.map((p) => p.b)}::text[],
          ${c.map((p) => p.sev)}::text[], ${c.map(() => 'DDInter')}::text[]
        )`;
      inserted += c.length;
    }
    const covered = new Set<string>();
    arr.forEach((p) => { covered.add(p.a); covered.add(p.b); });

    return NextResponse.json({
      ok: true, files_fetched: filesOk, files, rows_scanned: scanned,
      formulary_pairs: arr.length, inserted, distinct_formulary_drugs_covered: covered.size,
      elapsed_s: Math.round((Date.now() - start) / 1000),
      source: 'DDInter 2.0 (CC BY-NC-SA 4.0)', gate: 'Major + Moderate only',
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
