/**
 * lib/lvp-operator.ts — Low-value patterns L2: the IO layer (Neon + the governed Bedrock call).
 *
 * ⚠️ DECORATION ONLY (O11). This module writes `lvp_decorations` and NOTHING else. It touches no
 * finding, no score, no `opd_gov_signal`, no `mksap_chunks`, no `even_lvc_assertions`, no
 * `lvp_hidden`, and nothing in R3-A's rule book. It reads the shelf through `loadShelf()` — the
 * same producer the page uses — and every number on the card is still computed there, on read.
 *
 * ⚠️ OPUS ON BEDROCK, THROUGH `governedChat` WITH `{ bedrock }` (O12). Never OpenRouter, never
 * Gemini, never the local mini. F11 is standing policy and is the whole design here: an explicit
 * Bedrock target that cannot be served THROWS. It does not degrade to another provider, because a
 * row saying Bedrock while another model answered is the defect the attribution machinery exists to
 * prevent. So a failed run writes zero rows and the shelf shows stub copy — the designed behaviour,
 * not a gap to paper over. `assertKnownBedrockModel` refuses an unlisted id before the transport is
 * ever reached, which is why a mistyped LVP_OPERATOR_MODEL costs nothing.
 *
 * No new secrets: Bedrock auth rides the existing GCP_SA_KEY → STS chain (lib/bedrock.ts).
 *
 * ⚠️ EVERY SQL STRING HERE IS INFERRED — the builder's sandbox has no live DB. Each is reproduced
 * verbatim in the build report for validation against Neon before the migrate route is called.
 */

import { assertKnownBedrockModel } from './bedrock-core';
import { sql } from './db';
import { loadShelf } from './lvp-store';
import {
  LVP_OPERATOR_SYSTEM, operatorModel, operatorUserMessage, parseOperatorOutput, rejectionLogLines,
  screenDecorations,
  type Decoration, type OperatorPatternInput,
} from './lvp-operator-core';
import { finishTraceIfRunning, governedChat, startTrace } from './trace';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

// ── DDL (migration 0040 — reference copy in migrations/0040_lvp_decorations.sql) ────────────────
// The executable path is GET /api/admin/migrate-lvp-decorations: migrations/ is not bundled into
// the Vercel serverless function, so only code reachable through an import ships.

export const LVP_DECORATIONS_DDL = `CREATE TABLE IF NOT EXISTS lvp_decorations (
  pattern_id   text PRIMARY KEY,
  title        text NOT NULL,
  why          text NOT NULL,
  model        text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now()
)`;

export async function ensureLvpDecorationsTable(): Promise<void> {
  await run(LVP_DECORATIONS_DDL, []);
}

/**
 * UPSERT PER pattern_id (O14). Decorations are MACHINE OUTPUT: the current copy for a kind is the
 * only copy anyone wants, and a second run over the same shelf should replace it, not accumulate
 * history. Append-only ledgers stay reserved for HUMAN decisions — `lvp_hidden` is append-only
 * because a care manager hiding a kind is a decision worth keeping; a model rewriting a sentence
 * is not.
 */
export const UPSERT_DECORATION_SQL = `INSERT INTO lvp_decorations (pattern_id, title, why, model, generated_at)
VALUES ($1, $2, $3, $4, now())
ON CONFLICT (pattern_id) DO UPDATE
  SET title = EXCLUDED.title, why = EXCLUDED.why, model = EXCLUDED.model,
      generated_at = EXCLUDED.generated_at`;

async function upsertDecoration(d: Decoration, model: string): Promise<void> {
  await run(UPSERT_DECORATION_SQL, [d.pattern_id, d.title, d.why, model]);
}

// ── the run ─────────────────────────────────────────────────────────────────────────────────────

export interface OperatorRunResult {
  status: 'ok' | 'error' | 'skipped';
  trigger: 'cron' | 'manual';
  model: string;
  /** Patterns sent to the operator — the shelved head. */
  considered: number;
  /** Decorations written. */
  decorated: number;
  /** Parsed decorations refused by the length caps or the forbidden-strings filter, row-wise. */
  rejected: number;
  /** Why each refused pattern kept its stub copy — pattern_id → problems. */
  rejections: Array<{ pattern_id: string; problems: string[] }>;
  error?: string;
  note?: string;
}

const MAX_OUTPUT_TOKENS = 8000;

/**
 * One operator pass over the CURRENT shelved head.
 *
 * The head is what `loadShelf()` returns: already floor-filtered, already capped per block, hidden
 * kinds already excluded. This function does not re-derive any of that and must never be given a
 * reason to — the operator decorates what the shelf decided to show, so a kind that is not on the
 * shelf is never sent to a model at all.
 *
 * NEVER THROWS. Every failure path returns `status:'error'` with zero rows written, which is what
 * lets the route answer HTTP 200 with a status the cron can read.
 */
export async function runPatternOperator(opts: { trigger: 'cron' | 'manual' }): Promise<OperatorRunResult> {
  const model = operatorModel(process.env as Record<string, string | undefined>);
  const base: OperatorRunResult = {
    status: 'ok', trigger: opts.trigger, model,
    considered: 0, decorated: 0, rejected: 0, rejections: [],
  };
  const fail = (error: string): OperatorRunResult => ({ ...base, status: 'error', error: error.slice(0, 300) });

  // ⚠️ F11 FIRST, BEFORE ANY WORK. An unlisted model id is refused here rather than at the
  // transport, so a mistyped LVP_OPERATOR_MODEL costs one string comparison instead of a shelf
  // read and a provider round trip — and can never be served by something else.
  try { assertKnownBedrockModel(model); } catch (e) { return fail(String((e as Error).message)); }

  // 1) the shelved head
  let head: OperatorPatternInput[];
  try {
    const shelf = await loadShelf();
    head = shelf.suggested.map((s) => ({
      pattern_id: s.pattern_id, concept_id: s.concept_id,
      direction: s.direction, action: s.action, target: s.target,
      volume_week: s.volume_week, doctor_count: s.doctor_count,
      examples: s.examples,
    }));
  } catch (e) { return fail(`shelf read failed: ${String((e as Error).message)}`); }

  if (!head.length) {
    return { ...base, status: 'skipped', note: 'the shelf head is empty — nothing to decorate' };
  }

  // 2) the governed call. ONE provider, no ladder (F11).
  let traceId: string | undefined;
  try {
    traceId = await startTrace('lvp-operator', { model, patterns: head.length, trigger: opts.trigger });
  } catch { traceId = undefined; }

  let content = '';
  try {
    const completion = await governedChat(
      traceId, 'lvp-operator',
      {
        model,
        messages: [
          { role: 'system', content: LVP_OPERATOR_SYSTEM },
          { role: 'user', content: operatorUserMessage(head) },
        ],
        temperature: 0,
        max_tokens: MAX_OUTPUT_TOKENS,
      },
      // ⚠️ `bedrock` AND NOTHING ELSE. No `gemini`, no `openrouter`, no `noLocalFallback` — an
      // explicit Bedrock target has no ladder behind it, so there is nothing to switch off.
      { bedrock: model },
    ) as { choices?: Array<{ message?: { content?: string } }> };
    content = String(completion?.choices?.[0]?.message?.content ?? '');
    if (traceId) await finishTraceIfRunning(traceId, 'success').catch(() => {});
  } catch (e) {
    if (traceId) await finishTraceIfRunning(traceId, 'error', String((e as Error).message).slice(0, 200)).catch(() => {});
    // F11: this is the whole failure story. Nothing was served by another provider, nothing is
    // written, and the shelf keeps stub copy until a later run succeeds.
    return { ...fail(`bedrock operator call failed: ${String((e as Error).message)}`), considered: head.length };
  }

  // 3) parse, then screen ROW-WISE before any write (§5)
  const parsed = parseOperatorOutput(content, head.map((p) => p.pattern_id));
  const { accepted, rejected } = screenDecorations(parsed);

  // §2.4: a rejection used to vanish on the nightly run — the caller is a cron nobody reads. One
  // warn line per problem keeps pattern id, rule and span in the Vercel logs. Nothing rejected is
  // written to a table; there is no home in the schema for unvalidated model output.
  for (const line of rejectionLogLines(rejected)) console.warn(line);

  // 4) write only what survived
  let decorated = 0;
  for (const d of accepted) {
    try { await upsertDecoration(d, model); decorated++; }
    catch { /* one row's write failure leaves that kind on stub copy; the rest of the run proceeds */ }
  }

  return {
    ...base,
    status: 'ok',
    considered: head.length,
    decorated,
    rejected: rejected.length,
    rejections: rejected,
  };
}
