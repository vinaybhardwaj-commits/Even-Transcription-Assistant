// scripts/bedrock-opd-note-probe.mjs — §C2.3: grade ONE OPD note on Bedrock and inspect the result
// BEFORE any cron is wired.
//
// WHY THIS EXISTS AS A GATE. The OPD audit leg has never run on Claude. Its output is a JSON object
// the engine must parse — findings, pdqi9, suggestions — and its `max_tokens` was 2200, a number
// chosen for qwen. S1.3 measured the same class of failure on a much smaller leg: an ask critique
// truncated at ~2,900 characters and its JSON never closed, which the route swallowed into a
// zero-issue "clean" result. A truncated audit would be worse: it would parse partially, store, and
// silently under-score a doctor. So the first Claude-graded note is READ BY A HUMAN, not trusted.
//
// DRY BY DEFAULT: nothing is written to opd_note_audits unless --save is passed. The audit itself
// still costs a real Bedrock call and still creates a trace (that is the point — the trace is where
// the usage and the served model are recorded).
//
// Run (credentialed, never CI):
//   node --env-file=.env.local --import tsx scripts/bedrock-opd-note-probe.mjs --day 2026-07-15
//   node --env-file=.env.local --import tsx scripts/bedrock-opd-note-probe.mjs --day … --model sonnet
//
// scoring:false · reads db13 + writes a trace; no audit row unless --save.

import { auditOpdNote } from '../lib/opd-note-audit.ts';
import { countOpdNotesForDay, fetchOpdNotesForDay, istYesterday } from '../lib/metabase.ts';
import { auditedUidsForDayInLine, cloudAuditedUidsForDay, saveOpdAudit } from '../lib/opd-audit-store.ts';
import { BEDROCK_MODELS } from '../lib/bedrock-core.ts';
import { usageForTrace } from '../lib/backfill-runs.ts';
import { costUsd } from '../lib/llm-cost-core.ts';
import { telemetryContextFor } from '../lib/retrieval-telemetry-core.ts';
import { startInvocation } from '../lib/retrieval-invocation-store.ts';
import { settleOwned, outcomeForOwnedSave } from '../lib/retrieval-settlement.ts';
import { readRetrievalTelemetry } from '../lib/retrieval-telemetry-store.ts';
import { PRICING } from '../lib/llm-cost.ts';

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const SAVE = argv.includes('--save');
const log = (...a) => console.error(...a);

const IDS = Object.keys(BEDROCK_MODELS);
const ALIAS = { haiku: IDS[0], sonnet: IDS[1], opus: IDS[2] };
const MODEL = ALIAS[String(argOf('--model') ?? 'haiku').toLowerCase()] ?? argOf('--model') ?? IDS[0];

async function main() {
  const day = argOf('--day') || istYesterday();
  log(`\n§C2.3 single-note probe · model ${MODEL} · day ${day} · ${SAVE ? 'SAVE' : 'DRY (no row written)'}\n`);

  const total = await countOpdNotesForDay(day);
  const already = await auditedUidsForDayInLine(day);
  const cloudDone = await cloudAuditedUidsForDay(day);
  const skip = [...new Set([...already, ...cloudDone])];
  log(`day has ${total} note(s); ${skip.length} already audited in the current engine line → fetching 1 un-audited`);
  const rows = await fetchOpdNotesForDay(day, skip, 1);
  if (!rows.length) { log('no un-audited note on this day — pass a different --day'); process.exit(2); }

  // ⚠️ ONE INVOCATION PER PROCESS (D11). A script is a boundary like any route; what it is not is a
  // request, so there are no headers and the deployment SHA is whatever the local environment says.
  // Its route is `script`, which §8's overlap analysis reads as manual — never as a canary window.
  const ctx = telemetryContextFor('script', null);
  await startInvocation(ctx);
  let handle = null;
  let published = false;
  /** The last map the callback delivered (v10 requirement 4), for the paths that return no audit. */
  let publishedDefects;

  const started = Date.now();
  const audit = await auditOpdNote(rows[0], {
    bedrockModel: MODEL,
    telemetry: { ctx, route: 'script', persistenceIntent: SAVE ? 'will_persist' : 'never_persists' },
    // ⚠️ `if (d)` IS LOAD-BEARING. The DECLARATION publication passes no map, and letting it
    // overwrite a real one with undefined would throw away the verdict this exists to keep.
    onLifecycleHandleUpdated: (h, d) => { handle = h; published = true; if (d) publishedDefects = d; },
  });
  void published;
  const ms = Date.now() - started;

  const usage = await usageForTrace(audit.traceId);
  const usd = costUsd(MODEL, usage.tokensIn, usage.tokensOut, false, PRICING);

  // ── THE INSPECTION ──────────────────────────────────────────────────────────────────────────
  const findings = audit.findings ?? [];
  const pdqi9 = audit.scorecard?.pdqi9 ?? audit.pdqi9 ?? null;
  const suggestions = audit.suggestions ?? [];
  const json = JSON.stringify({ findings, suggestions }, null, 2);

  log(`\n── result ───────────────────────────────────────────────────────────────────`);
  log(`uid            ${audit.keys.uid}`);
  log(`engine         ${audit.engineVersion}   ⟵ must be the PLAIN prod line (no -mini/-tag)`);
  log(`trace          ${audit.traceId ?? '(none)'}`);
  log(`wall time      ${(ms / 1000).toFixed(1)}s`);
  log(`tokens         in ${usage.tokensIn} · out ${usage.tokensOut}   → $${usd.toFixed(4)}`);
  log(`index / band   ${audit.scorecard?.headline} / ${audit.scorecard?.band}`);
  log(`findings       ${findings.length}`);
  log(`suggestions    ${suggestions.length}`);
  log(`pdqi9 rated    ${pdqi9 ? Object.keys(pdqi9).length : 0} / 9`);

  // ── THE TRUNCATION CHECK, which is the whole reason for this script ─────────────────────────
  const problems = [];
  if (!findings.length) problems.push('ZERO findings — a truncated JSON parses to an empty array just as a clean note does');
  if (!pdqi9 || Object.keys(pdqi9).length !== 9) problems.push(`pdqi9 has ${pdqi9 ? Object.keys(pdqi9).length : 0} of 9 attributes — the parse did not complete`);
  for (const [i, f] of findings.entries()) {
    for (const [k, v] of Object.entries(f)) {
      if (typeof v === 'string' && /[,:;]\s*$/.test(v.trim())) problems.push(`findings[${i}].${k} ends mid-clause — "${v.slice(-60)}"`);
    }
    if (!f.subject || !f.verdict) problems.push(`findings[${i}] is missing subject/verdict — a partial object`);
  }
  const lastSuggestion = suggestions[suggestions.length - 1];
  if (lastSuggestion && typeof lastSuggestion === 'object') {
    for (const [k, v] of Object.entries(lastSuggestion)) {
      if (typeof v === 'string' && v.length > 0 && !/[.!?)\]"']$/.test(v.trim())) {
        problems.push(`the LAST suggestion's ${k} does not end in terminal punctuation — "${String(v).slice(-60)}"`);
      }
    }
  }

  log(`\n── truncation check ─────────────────────────────────────────────────────────`);
  if (problems.length === 0) log('CLEAN — findings JSON is structurally complete; no evidence of truncation.');
  else for (const p of problems) log(`  ⚠️  ${p}`);

  log(`\n── findings + suggestions JSON (read this, do not skim) ─────────────────────`);
  console.log(json);

  if (SAVE) {
    // As the worker (D9) — and its OWN save failure is `audit_persistence_failed`, because nothing
    // above this line would otherwise ever hear about it.
    let linked = false;
    let status;
    // ⚠️ A PERSISTENCE OWNER, SO IT CARRIES THE ROLE MAP (pass 0b). This path passed no defects at
    // all, so every row it settled read `persisted_clean` whatever its manifest actually said.
    // ⚠️ NO `?? {}` (v10 requirement 5). An empty map is NOT "no map": under requirement 6 a
    // PROVIDED map carrying no key for a role settles that linkable role partial, so `?? {}` would
    // have made every uninstrumented save partial and left requirement 7 unreachable. The attached
    // map first, then whatever the callback delivered, then undefined — which is a real answer.
    const defectsByRole = readRetrievalTelemetry(audit)?.manifestDefectsByRole ?? publishedDefects;
    try {
      status = await saveOpdAudit(audit, { model: MODEL, latencyMs: ms }, {
        onPersisted: async ({ status: st, auditId }) => { linked = true; await settleOwned(handle, outcomeForOwnedSave(st), auditId, defectsByRole); },
      });
    } catch (e) {
      // ⚠️ NO `closeInvocation` HERE, AND THAT IS DELIBERATE. Who closes an invocation is genuinely
      // unspecified — D9's owner matrix assigns settlement outcomes per path and names no closure
      // owner at all — so this build proposes an owner matrix in the report and wires none. A
      // script that ends without closing leaves `closure_unknown`, which is the honest record.
      await settleOwned(handle, 'audit_persistence_failed');
      throw e;
    }
    if (!linked) await settleOwned(handle, outcomeForOwnedSave(status), null, defectsByRole);
    log(`\nsaved: ${status} (model column = ${MODEL})`);
  } else {
    // The dry arm audits and deliberately writes nothing.
    await settleOwned(handle, 'no_persistence_intended');
    log(`\nDRY RUN — no row written. Re-run with --save to store it.`);
  }
  log(problems.length ? '\nVERDICT: SUSPECT — do not wire the cron until this is explained.' : '\nVERDICT: intact.');
}

main().then(() => process.exit(0)).catch((e) => { log('FAILED:', e?.stack ?? e?.message ?? e); process.exit(1); });
