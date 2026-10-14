// scripts/corpus-eval/deterministic-citations-stage1.mjs — Deterministic-Tier Citations, STAGE 1
// (PRD CDMSS-DETERMINISTIC-CITATIONS §6). READ-ONLY / PROPOSE-ONLY: retrieve candidates from
// mksap_chunks via the PRODUCTION embedding path (lib/retrieve, not FTS), verify each with the
// existing PR0/PR5 support-checker (lib/corpus-eval/verify — VERIFY_SYSTEM via governed tracedChat),
// and emit a per-entry audit table for V. Attaches NOTHING to any table; edits no data file.
//
// Inputs: all 10 data/dose-limits.json entries (claim = the specific ceiling) + the 19 DDI class
// rules that emit source 'EHRC class rule' (lib/ddi-tags TAG_RULES; claim = the MECHANISM only —
// severity is internal per PRD V3 and is never in the verify claim).
//
//   node --env-file=.env.local --import tsx scripts/corpus-eval/deterministic-citations-stage1.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { retrieve } from '../../lib/retrieve.ts';
import { verifyClaim } from '../../lib/corpus-eval/verify.ts';
import DOSE from '../../data/dose-limits.json' with { type: 'json' };
import { TAG_RULES } from '../../lib/ddi-tags.ts';

const OUT_DIR = '.corpus-eval/deterministic-citations';
const log = (...a) => console.error(...a);
const TOPK = 6, MAX_VERIFY = 4;

// Dose-source preference (PRD §6/§4): OpenFDA label > StatPearls > UpToDate > everything else
// (PubMed literature last). Lower rank = preferred.
function doseSourceRank(src) {
  const s = (src || '').toLowerCase();
  if (s.includes('openfda')) return 0;
  if (s.includes('statpearls')) return 1;
  if (s.includes('uptodate')) return 2;
  if (s.includes('pubmed') || s.startsWith('lit')) return 4;
  return 3;
}
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const SUPPORTED = new Set(['directly_supports', 'partially_supports']);

/** Retrieve → verify a single entry. Returns the best supporting citation, or a miss. */
async function verifyEntry(kind, claim, query) {
  let hits = [];
  try {
    const r = await retrieve(query, { topK: TOPK, useReranker: true, useSourceWeights: true, hybrid: true });
    hits = r.hits || [];
  } catch (e) { return { verdict: 'retrieve_error', error: String(e.message).slice(0, 120), candidates: 0, verified: 0 }; }
  if (!hits.length) return { verdict: 'no_candidate', candidates: 0, verified: 0 };

  // order: dose entries prefer authoritative label/monograph sources; DDI keeps corpus rank
  const ordered = kind === 'dose'
    ? [...hits].sort((a, b) => doseSourceRank(a.source) - doseSourceRank(b.source) || (b.source_quality_weight ?? 0) - (a.source_quality_weight ?? 0) || (b.rerank_score ?? 0) - (a.rerank_score ?? 0))
    : hits;

  let best = null, verified = 0;
  for (const h of ordered.slice(0, MAX_VERIFY)) {
    const meta = { book: h.book, chapter: h.chapter, source: h.source, page_start: h.page_start, item_number: h.item_number };
    let out;
    try { out = await verifyClaim(claim, [{ text: h.text, meta }]); }
    catch { continue; }
    verified++;
    if (out.fellBack) continue;                                   // a local-fallback verdict never enters the ledger
    const cand = {
      verdict: out.verdict,
      citation: { source: h.source, book: h.book, chapter: h.chapter, section: h.section, page_start: h.page_start, page_end: h.page_end },
      snippet: clip(out.supportingSpan || h.text, 240),
      source_quality_weight: h.source_quality_weight ?? null,
      why: clip(out.why, 120),
    };
    if (out.verdict === 'directly_supports') { best = cand; break; }        // short-circuit on a direct hit
    if (!best && SUPPORTED.has(out.verdict)) best = cand;                    // hold the first partial
    if (!best && (out.verdict === 'contradicts')) best = cand;              // surface a contradiction over silence
  }
  if (best) return { ...best, candidates: hits.length, verified };
  return { verdict: 'not_supported', candidates: hits.length, verified };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const rows = [];

  // ── dose ceilings (10) ──
  log(`[stage1] dose ceilings: ${DOSE.limits.length} entries`);
  for (const l of DOSE.limits) {
    const claim = `The maximum recommended adult daily dose of ${l.molecule} is ${l.max_mg_per_day} mg.`;
    const query = `${l.molecule} maximum recommended adult daily dose ceiling mg per day`;
    const res = await verifyEntry('dose', claim, query);
    rows.push({ table: 'dose-limits', entry: l.molecule, claim, ...res, derivation: SUPPORTED.has(res.verdict) ? 'external' : 'llm' });
    log(`[stage1] dose ${l.molecule}: ${res.verdict}${res.citation ? ` · ${res.citation.source}` : ''} (${res.verified}/${res.candidates})`);
  }

  // ── DDI class rules (19) — mechanism only ──
  log(`[stage1] DDI class rules: ${TAG_RULES.length} rules`);
  for (const r of TAG_RULES) {
    const claim = r.mechanism;                                    // severity NOT in the claim (V3)
    const query = `${r.a.replace(/_/g, ' ')} ${r.b.replace(/_/g, ' ')} drug interaction mechanism: ${r.mechanism}`;
    const res = await verifyEntry('ddi', claim, query);
    rows.push({ table: 'ddi-class-rule', entry: `${r.a} × ${r.b}`, claim, ...res, derivation: SUPPORTED.has(res.verdict) ? 'external' : 'llm', severity_internal: r.severity });
    log(`[stage1] ddi ${r.a}×${r.b}: ${res.verdict}${res.citation ? ` · ${res.citation.source}` : ''} (${res.verified}/${res.candidates})`);
  }

  // ── summary ──
  const perTable = {};
  for (const row of rows) {
    const t = perTable[row.table] ??= { entries: 0, supported: 0, would_deterministic: 0, would_internal: 0 };
    t.entries++;
    if (SUPPORTED.has(row.verdict)) { t.supported++; t.would_deterministic++; } else t.would_internal++;
  }
  const report = { generated: 'stage1 retrieve-and-verify (read-only, propose-only)', per_table: perTable, rows };
  writeFileSync(`${OUT_DIR}/stage1-proposals.json`, JSON.stringify(report, null, 1));

  // markdown table for V (repo root writer is the caller; here we emit alongside the json)
  const md = [
    `# Deterministic-tier citations — Stage 1 proposals (retrieve-and-verify)`, '',
    `Read-only / propose-only. Retrieval: production embedding path (\`lib/retrieve\`, reranked, source-weighted). Verification: \`verify-core/VERIFY_SYSTEM\` (Gemini Pro via governed tracedChat). DDI claims test the MECHANISM only — severity stays internal (PRD V3). Nothing attached to any table.`, '',
    `## Hit-rate summary`, '',
    `| Table | Entries | Supported (→ deterministic) | Unsupported (→ internal_consensus) |`,
    `|---|---|---|---|`,
    ...Object.entries(perTable).map(([t, s]) => `| ${t} | ${s.entries} | ${s.supported} (${Math.round(100 * s.supported / s.entries)}%) | ${s.entries - s.supported} |`),
    '',
    `## Per-entry`, '',
    `| table | entry | claim tested | verdict | proposed source | chapter/section/page | snippet (≤240) | derivation |`,
    `|---|---|---|---|---|---|---|---|`,
    ...rows.map((r) => {
      const c = r.citation;
      const loc = c ? [c.book, c.chapter, c.section, c.page_start != null ? `p${c.page_start}${c.page_end != null && c.page_end !== c.page_start ? `-${c.page_end}` : ''}` : null].filter(Boolean).join(' · ') : '—';
      return `| ${r.table} | ${r.entry} | ${clip(r.claim, 90)} | **${r.verdict}** | ${c ? c.source : '—'} | ${loc || '—'} | ${(r.snippet || '').replace(/\|/g, '\\|')} | ${r.derivation} |`;
    }),
  ].join('\n');
  writeFileSync(`${OUT_DIR}/stage1-proposals.md`, md + '\n');
  console.log(JSON.stringify({ per_table: perTable }, null, 2));
  log(`[stage1] → ${OUT_DIR}/stage1-proposals.{json,md}`);
}
main().catch((e) => { console.error('stage1 FAILED:', e); process.exit(1); });
