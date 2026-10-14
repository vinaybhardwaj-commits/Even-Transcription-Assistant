import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createHash } from 'crypto';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';
import { embedQuery, vectorLiteral } from '@/lib/llm';
import SEED from '@/data/choosing-wisely-seed.json';

export const runtime = 'nodejs';
export const maxDuration = 300; // embedding pass can be long for the broad seed

// Loads the Appropriateness / Low-Value-Care recommendations (PRD v1.1 §5, CW.1):
//   1) idempotent upsert into lvc_recommendations (structured exact-match layer)
//   2) embed statement+rationale into mksap_chunks (source='choosing-wisely') for semantic recall
//
// SAFETY GATE: records with verbatim_verified !== true are SKIPPED, never ingested — this is
// the guarantee that no unverified clinical wording reaches clinicians (mirrors the seed schema's
// verbatim_verified field; see choosing-wisely-seed.schema.json / cw-engine-seed/).
//
// ?dry=1            → report counts only (no writes)
// ?offset=N&limit=M → process a slice of the verified records (batch large seeds under maxDuration)

type Rec = {
  id: string;
  region: 'US' | 'CA' | 'IN';
  society: string;
  specialty: string;
  statement: string;
  precondition: string;
  action_type: string;
  consider_instead: string | null;
  rationale: string;
  keywords: string[];
  citation_doi: string | null;
  citation_pmid: string | null;
  citation_url: string;
  source_release_year: number;
  status: string;
  verbatim_verified: boolean;
  notes?: string;
};
type Seed = { schema_version: string; recommendations: Rec[] };

const sql2 = sql as unknown as (q: string, p: unknown[]) => Promise<Array<{ id?: number }>>;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const approxTokens = (s: string) => Math.max(1, Math.floor(s.length / 4));

function societySlug(society: string): string {
  return society.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'unknown';
}

// The corpus chunk text for a CW rec: statement + setting + rationale + alternative + attribution.
// Stored verbatim; the matcher/model paraphrases at query time.
function chunkText(r: Rec): string {
  const parts = [r.statement.trim()];
  if (r.precondition?.trim()) parts.push(`Setting: ${r.precondition.trim()}`);
  if (r.rationale?.trim()) parts.push(`Why: ${r.rationale.trim()}`);
  if (r.consider_instead?.trim()) parts.push(`Consider instead: ${r.consider_instead.trim()}`);
  // Provenance rider (Reasoning Observability Stage 3): guideline-derived rows (e.g.
  // cwus-ahaacchrs-001, per their seed `notes`) are NOT ABIM Choosing Wisely list items —
  // label them honestly instead of the fixed suffix. scoring:false; takes effect on re-seed.
  parts.push(`Source: ${r.society} (${/guideline-derived/i.test(r.notes ?? '') ? 'guideline-derived' : 'Choosing Wisely'}, ${r.region}, ${r.source_release_year}).`);
  return parts.join('\n');
}

export async function POST(req: NextRequest) {
  // Admin cookie (browser, same-origin) OR ?token=/Bearer ADMIN_TOKEN. Cookie path lets an
  // already-signed-in admin trigger the load from the browser without handling the token.
  if (!(await isAdminUnlocked())) { const denied = requireAdmin(req); if (denied) return denied; }

  const dryRun = req.nextUrl.searchParams.get('dry') === '1';
  const offset = Math.max(0, Number(req.nextUrl.searchParams.get('offset') || 0) | 0);
  const limitParam = req.nextUrl.searchParams.get('limit');
  const limit = limitParam ? Math.max(1, Number(limitParam) | 0) : Infinity;

  const seed = SEED as unknown as Seed;
  const all = Array.isArray(seed.recommendations) ? seed.recommendations : [];
  const verified = all.filter((r) => r.verbatim_verified === true);
  const parked = all.length - verified.length;
  const slice = verified.slice(offset, offset === 0 && limit === Infinity ? undefined : offset + limit);

  const out = {
    ok: true,
    dryRun,
    total: all.length,
    verified: verified.length,
    parked,
    processing: slice.length,
    offset,
    upserted: 0,
    embedded: 0,
    skipped_dup_chunk: 0,
    errors: [] as string[],
  };

  if (dryRun) return NextResponse.json(out);

  for (const r of slice) {
    try {
      const text = chunkText(r);
      const hash = sha256(text);

      // 1) structured upsert (idempotent on id)
      await sql2(
        `INSERT INTO lvc_recommendations
           (id, region, society, specialty, statement, precondition, action_type,
            consider_instead, rationale, keywords, citation_doi, citation_pmid,
            citation_url, source_release_year, status, chunk_text_hash, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11,$12,$13,$14,$15,$16, now())
         ON CONFLICT (id) DO UPDATE SET
           region=EXCLUDED.region, society=EXCLUDED.society, specialty=EXCLUDED.specialty,
           statement=EXCLUDED.statement, precondition=EXCLUDED.precondition, action_type=EXCLUDED.action_type,
           consider_instead=EXCLUDED.consider_instead, rationale=EXCLUDED.rationale, keywords=EXCLUDED.keywords,
           citation_doi=EXCLUDED.citation_doi, citation_pmid=EXCLUDED.citation_pmid, citation_url=EXCLUDED.citation_url,
           source_release_year=EXCLUDED.source_release_year, status=EXCLUDED.status,
           chunk_text_hash=EXCLUDED.chunk_text_hash, updated_at=now()`,
        [r.id, r.region, r.society, r.specialty, r.statement, r.precondition, r.action_type,
         r.consider_instead, r.rationale, r.keywords ?? [], r.citation_doi, r.citation_pmid,
         r.citation_url, r.source_release_year, r.status, hash],
      );
      out.upserted++;

      // 2) corpus embed into mksap_chunks (semantic recall leg)
      const book = `CW-${societySlug(r.society)}`;
      const emb = vectorLiteral(await embedQuery(text));
      const ins = await sql2(
        `INSERT INTO mksap_chunks (source, book, chapter, section, item_number, chunk_type, text, text_hash, embedding, token_count)
         VALUES ('choosing-wisely', $1, $2, $3, $4, 'recommendation', $5, $6, $7::vector, $8)
         ON CONFLICT (book, text_hash) DO NOTHING RETURNING id`,
        [book, r.society, r.specialty, r.id, text, hash, emb, approxTokens(text)],
      );
      if (ins.length > 0) out.embedded++; else out.skipped_dup_chunk++;
    } catch (e) {
      out.errors.push(`${r.id}: ${(e as Error).message}`);
    }
  }

  out.ok = out.errors.length === 0;
  return NextResponse.json(out, { status: out.ok ? 200 : 500 });
}
