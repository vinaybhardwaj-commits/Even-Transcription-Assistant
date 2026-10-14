// scripts/cost-column-backfill.mjs — ONE-SHOT data migration: bring the envelope COST columns on
// historic trace_events rows up to the payload's truth. Nothing about what runs changes; this only
// repairs what was recorded.
//
// WHY. `707bd0e` made the cost columns billing-accurate GOING FORWARD. Historic rows still carry
// NULL (every pre-fix multimodal PDF read, and older call sites that logged llm_response without an
// envelope) or completion-only `tokens_out` (reasoning-blind — Gemini 2.5 bills thinking tokens at
// the output rate but excludes them from completion_tokens). The $ dashboard (lib/llm-cost.ts)
// prices history correctly from `payload.usage` and needs NOTHING — this exists so the COLUMN path
// agrees with it across all history, and a future column-based reader can't reproduce the
// S6-shaped 3×-low number.
//
// THE PAYLOAD IS THE SINGLE SOURCE OF TRUTH. Every value is recomputed from `payload.usage` through
// the SHARED billableOutputTokens() from lib/llm-cost-core — the same function the writers use, not
// a re-derivation in SQL. That is the whole point: one rule, one statement of it.
//
// ONLY THE FOUR COST COLUMNS: tokens_in, tokens_out, call_model, call_provider.
// The FINGERPRINT columns (prompt_id/prompt_version/prompt_hash/rubric_versions/
// output_schema_version/gen_params) are NEVER touched — they belong to the caller that owns the
// prompt, and this backfill has no business inferring them.
//
// IDEMPOTENT: values are computed from the payload every run and never read back from the column,
// so a re-run yields byte-identical columns and repairs any partial run. Rows with no
// `payload.usage` are LEFT ALONE (no invented zeros).
//
// Run (credentialed, never CI):
//   node --env-file=.env.local --import tsx scripts/cost-column-backfill.mjs            # dry run
//   node --env-file=.env.local --import tsx scripts/cost-column-backfill.mjs --apply
//   node --env-file=.env.local --import tsx scripts/cost-column-backfill.mjs --verify   # proof only
//
// scoring:false · data migration only; no engine, frozen core, prompt or model change. No PHI is
// read or written — token counts and model/provider strings only.

import { sql } from '../lib/db.ts';
import { billableOutputTokens, costInr } from '../lib/llm-cost-core.ts';
import { PRICING, costLog } from '../lib/llm-cost.ts';

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const APPLY = argv.includes('--apply');
const VERIFY_ONLY = argv.includes('--verify');
const BATCH = Math.max(50, Math.min(2000, Number(argOf('--batch') ?? 500) | 0));
const APP = process.env.APP_SOURCE || 'standalone';
const log = (...a) => console.error(...a);            // stderr: stdout block-buffers through a pipe

// The dashboard's own predicate, mirrored exactly so the two paths see the SAME row set:
// lib/llm-cost.ts prices kind IN ('llm_response','llm_stream_usage') AND payload.model ILIKE
// '%gemini%'. We additionally require payload.usage — a row without it has nothing to recompute
// from and is left untouched.
const PRED = `kind IN ('llm_response', 'llm_stream_usage')
              AND (payload->>'model') ILIKE '%gemini%'
              AND payload->'usage' IS NOT NULL`;

const n = (v) => Number(v) || 0;
const inr = (v) => `₹${v.toFixed(2)}`;

// ── backfill ────────────────────────────────────────────────────────────────────────────────────

async function backfill() {
  const [{ total }] = await sql(`SELECT count(*)::int AS total FROM trace_events WHERE ${PRED}`);
  const [{ skipped }] = await sql(
    `SELECT count(*)::int AS skipped FROM trace_events
     WHERE kind IN ('llm_response','llm_stream_usage') AND (payload->>'model') ILIKE '%gemini%'
       AND payload->'usage' IS NULL`);
  log(`[backfill] ${APPLY ? 'APPLY' : 'DRY RUN'} · ${total} candidate rows · batch ${BATCH}`);
  log(`[backfill] ${skipped} gemini response rows have NO payload.usage — left untouched by design`);

  let lastId = 0, scanned = 0, changed = 0, unchanged = 0;
  const before = { tokens_out: 0, tokens_in: 0 };
  const after = { tokens_out: 0, tokens_in: 0 };
  let modelFilled = 0, providerFilled = 0;

  for (;;) {
    // Batched by the bigint PK: bounded work per statement, no long lock on trace_events.
    const rows = await sql(
      `SELECT id, payload, tokens_in, tokens_out, call_model, call_provider
       FROM trace_events WHERE ${PRED} AND id > $1 ORDER BY id LIMIT ${BATCH}`, [lastId]);
    if (!rows.length) break;
    lastId = Number(rows[rows.length - 1].id);
    scanned += rows.length;

    const ids = [], tins = [], touts = [], models = [], providers = [];
    for (const r of rows) {
      const p = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
      const usage = p?.usage;
      if (!usage) { unchanged++; continue; }                 // defensive: PRED already excludes these

      const tin = n(usage.prompt_tokens);
      const tout = billableOutputTokens(usage);              // THE shared rule — never re-derived here
      const model = p.model ?? null;
      const provider = p.provider ?? null;

      before.tokens_in += n(r.tokens_in); before.tokens_out += n(r.tokens_out);
      after.tokens_in += tin; after.tokens_out += tout;
      if (r.call_model == null && model != null) modelFilled++;
      if (r.call_provider == null && provider != null) providerFilled++;

      const same = n(r.tokens_in) === tin && n(r.tokens_out) === tout
        && r.tokens_in != null && r.tokens_out != null
        && (r.call_model != null || model == null) && (r.call_provider != null || provider == null);
      if (same) { unchanged++; continue; }
      changed++;
      ids.push(Number(r.id)); tins.push(tin); touts.push(tout); models.push(model); providers.push(provider);
    }

    if (APPLY && ids.length) {
      // ONLY the four cost columns. call_model/call_provider use COALESCE so a value the owning
      // caller already stamped is never overwritten; tokens_* are always the payload's truth.
      await sql(
        `UPDATE trace_events e SET
           tokens_in = v.tin, tokens_out = v.tout,
           call_model = COALESCE(e.call_model, v.model),
           call_provider = COALESCE(e.call_provider, v.provider)
         FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::int[]) AS tin, unnest($3::int[]) AS tout,
                      unnest($4::text[]) AS model, unnest($5::text[]) AS provider) v
         WHERE e.id = v.id`,
        [ids, tins, touts, models, providers]);
    }
    if (scanned % 2000 === 0 || rows.length < BATCH) log(`[backfill]   ${scanned}/${total} scanned · ${changed} ${APPLY ? 'written' : 'would change'}`);
  }

  log(`\n[backfill] scanned ${scanned} · ${APPLY ? 'written' : 'would change'} ${changed} · already correct ${unchanged}`);
  log(`[backfill] call_model filled: ${modelFilled} · call_provider filled: ${providerFilled}`);
  log(`[backfill] tokens_out total: ${before.tokens_out.toLocaleString()} → ${after.tokens_out.toLocaleString()} (${before.tokens_out ? (after.tokens_out / before.tokens_out).toFixed(2) : '∞'}×)`);
  log(`[backfill] tokens_in  total: ${before.tokens_in.toLocaleString()} → ${after.tokens_in.toLocaleString()}`);
  return { total, skipped, scanned, changed, unchanged, modelFilled, providerFilled, before, after };
}

// ── proof: the column roll-up must equal the payload dashboard, ₹ for ₹ ─────────────────────────

/** ₹ from the COLUMNS, grouped exactly as lib/llm-cost.ts groups (model × hi-tier). */
async function columnInr(from, to) {
  const rows = await sql(
    `SELECT e.call_model AS model, (coalesce(e.tokens_in,0) > 200000) AS hi,
            sum(coalesce(e.tokens_in,0))::bigint AS in_tok, sum(coalesce(e.tokens_out,0))::bigint AS out_tok,
            count(*)::int AS calls
     FROM trace_events e JOIN traces t ON t.trace_id = e.trace_id
     WHERE ${PRED.replace(/\bkind\b/, 'e.kind').replace(/\bpayload\b/g, 'e.payload')}
       AND e.app_source = $1
       AND (e.ts AT TIME ZONE 'Asia/Kolkata')::date >= $2::date
       AND (e.ts AT TIME ZONE 'Asia/Kolkata')::date <= $3::date
     GROUP BY 1, 2`, [APP, from, to]);
  let total = 0, calls = 0, inTok = 0, outTok = 0;
  for (const r of rows) {
    total += costInr(String(r.model ?? ''), n(r.in_tok), n(r.out_tok), r.hi === true, PRICING);
    calls += n(r.calls); inTok += n(r.in_tok); outTok += n(r.out_tok);
  }
  return { total, calls, inTok, outTok };
}

/** ₹ from the shipped PAYLOAD dashboard — the reference that was always right. */
async function dashboardInr(from, to) {
  const r = await costLog({ from, to, pageSize: 10 });   // totals are computed over the whole filter
  return { total: r.totalInr, calls: r.total, inTok: r.totalInTok, outTok: r.totalOutTok };
}

async function verify(label) {
  const [{ from, to }] = await sql(
    `SELECT to_char(min(ts) AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS from,
            to_char(max(ts) AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS to
     FROM trace_events WHERE ${PRED}`);
  const [col, dash] = [await columnInr(from, to), await dashboardInr(from, to)];
  const delta = col.total - dash.total;
  log(`\n── PROOF ${label} · historic window ${from} → ${to} ──`);
  log(`   columns   : ${inr(col.total)}  (${col.calls} calls · in ${col.inTok.toLocaleString()} · out ${col.outTok.toLocaleString()})`);
  log(`   dashboard : ${inr(dash.total)}  (${dash.calls} calls · in ${dash.inTok.toLocaleString()} · out ${dash.outTok.toLocaleString()})`);
  log(`   |Δ|       : ${inr(Math.abs(delta))}${Math.abs(delta) < 0.005 ? '   ✅ EXACT AGREEMENT' : '   ❌ DISAGREE — STOP AND REPORT'}`);
  return { from, to, col, dash, delta };
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────

if (VERIFY_ONLY) { await verify('(verify only)'); process.exit(0); }

const pre = await verify('BEFORE');
const stats = await backfill();
const post = await verify(APPLY ? 'AFTER' : 'AFTER (dry run — unchanged, as expected)');

if (APPLY) {
  if (Math.abs(post.delta) >= 0.005) {
    log(`\n❌ STOP: the column path and the payload path DISAGREE by ${inr(Math.abs(post.delta))} after the backfill.`);
    log(`   That is a FINDING, not a cleanup — a payload the two formulas read differently.`);
    process.exit(1);
  }
  log(`\n✅ Backfill complete and proven: the column path now equals the payload dashboard, ₹ for ₹.`);
  log(`   Historic column total: ${inr(pre.col.total)} → ${inr(post.col.total)} (${pre.col.total ? (post.col.total / pre.col.total).toFixed(2) : '∞'}× — newly VISIBLE existing cost, not new spend).`);
  log(`   The dashboard figure did not move (${inr(pre.dash.total)} → ${inr(post.dash.total)}): it was always right.`);
}
void stats;
process.exit(0);
