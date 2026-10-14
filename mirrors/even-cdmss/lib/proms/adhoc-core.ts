// lib/proms/adhoc-core.ts — PROMs Tier-3 pure substrate (adhoc-gen/0.1). Validates a selection of
// house-item ids into a sanitized adhoc set, and scores an adhoc set with the EXACT frozen house
// semantics (delegates to scoreHouseItems — no re-implementation of the sum). Plus the versioned
// generation-prompt constant (data only; NOT invoked here). Pure: no Date.now, no DB, no LLM call.
//
// T1 (settled 12 Jul): selection-only. The engine picks ≤6 EXISTING item-ids from the supplied bank;
// it can NEVER author new item text. Zero valid ids → empty set (caller falls back to core + PREM).

import { scoreHouseItems, PROM_SCORING_VERSION } from './schedule-core';
import { type BankItem, toItem } from './item-bank-core';

export const ADHOC_GEN_VERSION = 'adhoc-gen/0.1' as const;

/** Max items an adhoc set may contain (T1 cap). */
export const ADHOC_MAX_ITEMS = 6;

/** A sanitized adhoc instrument: an ordered list of bank items (≤6), scored as a house set. */
export interface AdhocSet {
  items: BankItem[];
}

export interface AdhocItemResponse { itemId: string; value: string }

/** Validate a raw id selection against the bank (T1, selection-only):
 *  keep only ids present in the bank, dedupe, preserve first-seen order, cap at ADHOC_MAX_ITEMS.
 *  Zero valid ids → empty set. There is NO new-item path — unknown ids are simply dropped. */
export function validateAdhocSelection(ids: string[], bank: BankItem[]): AdhocSet {
  const byId = new Map<string, BankItem>();
  for (const b of bank) if (!byId.has(b.id)) byId.set(b.id, b);
  const items: BankItem[] = [];
  const taken = new Set<string>();
  for (const raw of ids || []) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id || taken.has(id)) continue;
    const hit = byId.get(id);
    if (!hit) continue;                       // unknown id → dropped (no author path)
    taken.add(id);
    items.push(hit);
    if (items.length >= ADHOC_MAX_ITEMS) break;
  }
  return { items };
}

/** Score an adhoc set with the frozen house kernel: Σ optionIndex; complete-gate else null; ⚠ via
 *  triggers(). scoreHouseItems is the single source of truth — this only builds the item list + Map. */
export function scoreAdhocSet(setDef: AdhocSet, responses: AdhocItemResponse[]): { score: number | null; scale: string; version: string; escalations: string[] } {
  const byId = new Map((responses || []).map((r) => [r.itemId, r.value]));
  const { score, escalations } = scoreHouseItems(setDef.items.map(toItem), byId);
  return { score, scale: 'house', version: PROM_SCORING_VERSION, escalations };
}

/** Versioned generation prompt (DATA — not invoked in this phase). A future Tier-3 caller supplies the
 *  compiled bank + the procedure context; the model MUST select from the bank only and never write text. */
export const ADHOC_GEN_PROMPT = [
  'You are assembling a short post-operative PROMs check for a procedure that has no ratified house set.',
  '',
  'You are given a BANK of existing, pre-approved question items. Each item has: id, text, scale, and',
  'sourceSet (the clinical domain it was written for). Your job is SELECTION ONLY.',
  '',
  'Rules (hard):',
  `- Select at most ${ADHOC_MAX_ITEMS} item ids, using ONLY ids that appear in the supplied bank.`,
  '- NEVER invent, rewrite, paraphrase, or translate item text. You may not author new items.',
  '- Prefer items whose sourceSet domain matches the procedure; add generic recovery/wound items only',
  '  where they add signal.',
  '- Return each chosen id with a one-line rationale for why it fits this procedure.',
  '- If nothing in the bank fits, return an empty selection (the system falls back to the core set).',
  '',
  'Respond with ONLY a JSON object of this exact shape (no prose, no markdown):',
  '{ "selection": [ { "id": "<a bank id>", "rationale": "<one short line>" } ], "gaps": [ "<a clinically-relevant concern this procedure has that NO bank item covers>" ] }',
  '- "selection": your chosen bank ids (≤6), each with a one-line rationale. Ids MUST be copied verbatim from the bank.',
  '- "gaps": short phrases for anything important this procedure needs that the bank cannot cover (may be empty []).',
  '- If nothing in the bank fits, return { "selection": [], "gaps": [ ... ] } and the system falls back to the core set.',
].join('\n');
