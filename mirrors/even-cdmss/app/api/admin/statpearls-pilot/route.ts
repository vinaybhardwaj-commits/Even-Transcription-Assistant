import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { sql } from '@/lib/db';
import { embedQuery, vectorLiteral } from '@/lib/llm';
import { createHash } from 'crypto';

export const runtime = 'nodejs';
export const maxDuration = 60;

const KEEP_SECTIONS = new Set([
  'Continuing Education Activity', 'Introduction', 'Etiology', 'Epidemiology',
  'Pathophysiology', 'Histopathology', 'History and Physical', 'Evaluation',
  'Treatment / Management', 'Differential Diagnosis', 'Pertinent Studies and Ongoing Trials',
  'Prognosis', 'Complications', 'Consultations', 'Deterrence and Patient Education',
  'Pearls and Other Issues', 'Enhancing Healthcare Team Outcomes',
]);

function stripHtml(s: string): string {
  s = s.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<\/?(br|p|li|div|tr|h\d|td|th)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  // Basic HTML entity unescape
  s = s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_m, e) => {
    const map: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (map[e]) return map[e];
    if (e[0] === '#') {
      const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return isFinite(n) ? String.fromCodePoint(n) : _m;
    }
    return _m;
  });
  s = s.replace(/\n\s*\n+/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
  return s;
}

function approxTokens(s: string) { return Math.max(1, Math.floor(s.length / 4)); }
function sha256(s: string) { return createHash('sha256').update(s).digest('hex'); }

function splitPassages(t: string) { return t.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean); }

function packChunks(passages: string[], target = 600, overlap = 80, minChars = 200): string[] {
  const chunks: string[] = [];
  let cur: string[] = []; let curTok = 0;
  for (const p of passages) {
    const pt = approxTokens(p);
    if (curTok + pt > target && cur.length) {
      chunks.push(cur.join('\n\n').trim());
      const ov: string[] = []; let ovTok = 0;
      for (let i = cur.length - 1; i >= 0; i--) {
        if (ovTok >= overlap) break;
        ov.unshift(cur[i]); ovTok += approxTokens(cur[i]);
      }
      cur = ov.slice(); curTok = ovTok;
    }
    cur.push(p); curTok += pt;
  }
  if (cur.length) chunks.push(cur.join('\n\n').trim());
  return chunks.filter(c => c.length >= minChars);
}

async function fetchArticle(nbk: string) {
  const r = await fetch(`https://www.ncbi.nlm.nih.gov/books/${nbk}/`, {
    headers: { 'User-Agent': 'Even-CDMSS/0.2 (+vinay.bhardwaj@even.in)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`fetch ${nbk}: HTTP ${r.status}`);
  return r.text();
}

function parseArticle(raw: string, nbk: string) {
  const titleM = raw.match(/<title>([^<]+)<\/title>/i);
  let title = titleM ? stripHtml(titleM[1]) : nbk;
  title = title.replace(/\s*-\s*StatPearls\s*-\s*NCBI\s*Bookshelf\s*$/, '').trim();
  const parts = raw.split(/(<h2[^>]*>)/i);
  const sections: { name: string; text: string }[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    let body = parts[i + 1] || '';
    const m = body.match(/^([^<]*)<\/h2>/i);
    let secTitle = '?';
    if (m) {
      secTitle = stripHtml(m[1]);
      body = body.slice(m[0].length);
    }
    if (KEEP_SECTIONS.has(secTitle)) {
      const text = stripHtml(body);
      if (text.length >= 200) sections.push({ name: secTitle, text });
    }
  }
  return { title, sections };
}

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  let body: { nbks?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  const nbks = body.nbks || [];
  if (!nbks.length) return NextResponse.json({ error: 'nbks required' }, { status: 400 });

  const results: Array<Record<string, unknown>> = [];
  for (const nbk of nbks) {
    try {
      const raw = await fetchArticle(nbk);
      const art = parseArticle(raw, nbk);
      let inserted = 0; let skipped = 0;
      for (const sec of art.sections) {
        const passages = splitPassages(sec.text);
        const chunks = packChunks(passages);
        for (const c of chunks) {
          const emb = await embedQuery(c);
          const vlit = vectorLiteral(emb);
          const h = sha256(c);
          const tokens = approxTokens(c);
          const chunkType = sec.name.toLowerCase().replace(/ \/ /g, '_').replace(/ /g, '_');
          const ret = (await (sql as unknown as (q: string, p: unknown[]) => Promise<Array<{ id?: number }>>)(
            `INSERT INTO mksap_chunks
              (source, book, chapter, section, page_start, page_end, item_number, chunk_type, text, text_hash, embedding, token_count)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector,$12)
             ON CONFLICT (book, text_hash) DO NOTHING
             RETURNING id`,
            ['statpearls', 'StatPearls', art.title, sec.name, null, null, nbk, chunkType, c, h, vlit, tokens]
          ));
          if (ret.length > 0) inserted++; else skipped++;
        }
      }
      results.push({ nbk, title: art.title, sections: art.sections.length, inserted, skipped });
    } catch (e) {
      results.push({ nbk, error: String((e as Error).message) });
    }
  }

  const total = (await sql`SELECT source, COUNT(*)::int AS n FROM mksap_chunks GROUP BY source ORDER BY source`) as Array<{source: string; n: number}>;
  return NextResponse.json({ results, total_by_source: total });
}
