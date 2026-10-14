// scripts/lab-attribution-correct.mjs — ONE-SHOT correction: retract a lab_analyses row's claim to
// have been served by a model that did not serve it.
//
// WHY. On 7 Aug 2026 two `lab_ask` probes stored rows naming a model that never ran. The route's
// A12 override gate refused the override (silently, by design); the route ran its production
// default; the MCP stamped the row from the model it had RESOLVED. Nothing threw. The rows read as
// a Bedrock result and a Vertex result; every LLM leg of both had executed on the local mini.
//
// lib/lab-attribution-core.ts + the DEC-2 gate in runLabProbe stop this happening again. This
// script repairs the two rows that were stored BEFORE that gate existed, so no historic row stands
// as evidence for a model that did not answer.
//
// WHAT IT DOES, PER ROW:
//   · rewrites `provider` and `model` to what the TRACE says served — these are the columns readers
//     trust (the paid-run ceiling counts `provider`; lab_query/audit_query group by `model`), so
//     annotating without rewriting would leave every aggregate still wrong;
//   · merges an `attribution_correction` envelope into `output` that PRESERVES the original claim,
//     names the trace, and lists the legs. The row explains itself without this file.
// The ANSWER TEXT IS NEVER TOUCHED. The work happened; only the claim about who did it was false.
//
// IDEMPOTENT: a row that already carries `attribution_correction` is skipped, and the corrected
// values are constants below, never read back from the columns being written.
//
// Run (credentialed, never CI):
//   node --env-file=.env.local --import tsx scripts/lab-attribution-correct.mjs           # dry run
//   node --env-file=.env.local --import tsx scripts/lab-attribution-correct.mjs --apply
//
// scoring:false · lab_analyses only. No engine, prompt, model or clinical output changes. No PHI.

import { sql } from '../lib/db.ts';

const APPLY = process.argv.slice(2).includes('--apply');
const log = (...a) => console.error(...a);

/**
 * The two rows, with the truth taken from v_stage_latency + traces.model_summary on 7 Aug 2026.
 * `served_model` is the model that produced the STORED answer (both runs were revised, so the
 * revision leg's model), and `legs` records the full run so the correction is auditable.
 */
const CORRECTIONS = [
  {
    id: '50da0b39-f939-41f1-b2a5-5e6db46c1264',
    experiment: 'bedrock_s1_verification',
    trace_id: 'ba35cf03-80ec-43d5-98af-5204c23cc36d',
    claimed_provider: 'bedrock',
    claimed_model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    served_provider: 'ollama',
    served_model: 'qwen2.5:7b',
    legs: { draft: 'qwen2.5:14b', critique: 'qwen2.5:7b', revision: 'qwen2.5:7b' },
    why: 'S1 verification 1. The A12 override gate refused the override (the MCP self-post carries no admin cookie, so gate condition 3 `not_admin` fails); the route ran its production default. No bedrock event exists in the trace and no error was raised.',
  },
  {
    id: '3bef17a0-0b62-4fb9-915e-2fbc54763175',
    experiment: 'bedrock_s1_diag',
    trace_id: 'fe1c1b23-86ed-4e6e-9739-8b1505ef95bb',
    claimed_provider: 'vertex',
    claimed_model: 'gemini-2.5-pro',
    served_provider: 'ollama',
    served_model: 'qwen2.5:7b',
    legs: { draft: 'qwen2.5:14b', critique: 'qwen2.5:7b', revision: 'qwen2.5:7b' },
    why: 'The differential-diagnosis probe run while investigating the row above. It reproduced the same refusal with a vertex target, which is what proved the failure was gate-wide and not Bedrock-specific. Corrected here for the same reason as the row it was run to explain.',
  },
];

async function main() {
  log(`lab attribution correction — ${APPLY ? 'APPLY' : 'DRY RUN'} · ${CORRECTIONS.length} row(s)\n`);
  let corrected = 0, skipped = 0;

  for (const c of CORRECTIONS) {
    const rows = await sql(
      `SELECT id, experiment, provider, model, output FROM lab_analyses WHERE id = $1`, [c.id]);
    const row = rows?.[0];
    if (!row) { log(`  MISSING ${c.id} — no such row, skipping`); skipped++; continue; }

    const output = (row.output && typeof row.output === 'object') ? row.output : {};
    if (output.attribution_correction) {
      log(`  SKIP    ${c.id} — already corrected (${row.provider}:${row.model})`);
      skipped++; continue;
    }
    if (row.provider !== c.claimed_provider || row.model !== c.claimed_model) {
      log(`  SKIP    ${c.id} — row does not carry the claim this script was written for ` +
          `(found ${row.provider}:${row.model}, expected ${c.claimed_provider}:${c.claimed_model})`);
      skipped++; continue;
    }

    const nextOutput = {
      ...output,
      // The run is no longer a clean result: its stored provider/model were wrong when written.
      status: 'corrected',
      attribution_correction: {
        corrected_on: '2026-08-07',
        claimed_provider: c.claimed_provider,
        claimed_model: c.claimed_model,
        served_provider: c.served_provider,
        served_model: c.served_model,
        legs: c.legs,
        trace_id: c.trace_id,
        why: c.why,
        note: 'The answer text is the run\'s real output and is unchanged. Only the claim about which model produced it has been retracted. Guarded going forward by lib/lab-attribution-core.ts (F11 DEC-2).',
      },
    };

    log(`  ${APPLY ? 'FIX    ' : 'WOULD  '} ${c.id} (${c.experiment})`);
    log(`           ${c.claimed_provider}:${c.claimed_model}`);
    log(`        →  ${c.served_provider}:${c.served_model}   [trace ${c.trace_id}]`);

    if (APPLY) {
      await sql(
        `UPDATE lab_analyses SET provider = $2, model = $3, output = $4::jsonb WHERE id = $1`,
        [c.id, c.served_provider, c.served_model, JSON.stringify(nextOutput)]);
    }
    corrected++;
  }

  log(`\n${APPLY ? 'corrected' : 'would correct'} ${corrected} · skipped ${skipped}`);

  if (APPLY) {
    const check = await sql(
      `SELECT id, provider, model, output->>'status' AS status,
              (output->'attribution_correction' IS NOT NULL) AS corrected
         FROM lab_analyses WHERE id = ANY($1::uuid[]) ORDER BY created_at`,
      [CORRECTIONS.map((c) => c.id)]);
    log('\nverification:');
    for (const r of check) log(`  ${r.id}  ${r.provider}:${r.model}  status=${r.status}  corrected=${r.corrected}`);
    const stillPaid = check.filter((r) => r.provider && r.provider !== 'ollama');
    log(stillPaid.length
      ? `\n⚠️ ${stillPaid.length} row(s) still claim a paid provider — investigate before reporting`
      : '\nno corrected row claims a paid provider any more.');
  }
}

main().then(() => process.exit(0)).catch((e) => { log('FAILED:', e?.message ?? e); process.exit(1); });
