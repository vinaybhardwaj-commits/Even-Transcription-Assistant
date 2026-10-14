// lib/proms/adhoc.ts — PROMs Tier-3 WIRED generation (0.2b-2). For an unmapped surgical series a Care
// Manager triggers this: compile the frozen house-item bank, hand the model the bank + a DE-IDENTIFIED
// procedure context, and let it SELECT ≤6 existing item ids (never author text). validateAdhocSelection
// is the safety gate; the result persists as a draft. Traced through lib/llm (utility tier), soft-fails
// to null so the route falls back to core+PREM. No new model/provider, no new dep.

import { startTrace, governedChat, finishTrace, logEvent } from '../trace';
import { geminiUtilityModel, geminiModelFor, TEXT_MODEL } from '../llm';
import { compileItemBank, bankById, type BankItem } from './item-bank-core';
import { validateAdhocSelection, ADHOC_GEN_PROMPT, ADHOC_GEN_VERSION, ADHOC_MAX_ITEMS } from './adhoc-core';
import { upsertDraftAdhocSet } from './adhoc-store';

/** Deterministic adhoc-set id for a series (constant across regenerate → stable adhocSetRef for the spine). */
export const adhocSetIdForSeries = (seriesId: string): string => `adh:${seriesId}`;

export interface AdhocDraftItem { id: string; text: string | null; scale: string; sourceSet: string; escalation: string | null; rationale: string | null }
export interface AdhocDraft {
  id: string; seriesId: string; status: 'draft'; genVersion: string;
  items: AdhocDraftItem[]; gaps: string[];
}

interface ModelPick { id: string; rationale?: string }
interface ModelOut { selection: ModelPick[]; gaps: string[] }

/** Pull the first JSON object out of a model response (tolerant of ```json fences / prose). */
function parseModelOut(text: string): ModelOut {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try {
    const j = JSON.parse(s) as Record<string, unknown>;
    const sel = Array.isArray(j.selection) ? j.selection : [];
    const selection: ModelPick[] = sel.map((p) => {
      const o = (p ?? {}) as Record<string, unknown>;
      return { id: String(o.id ?? '').trim(), rationale: o.rationale == null ? undefined : String(o.rationale) };
    }).filter((p) => p.id);
    const gaps = Array.isArray(j.gaps) ? j.gaps.map((g) => String(g)).filter(Boolean) : [];
    return { selection, gaps };
  } catch { return { selection: [], gaps: [] }; }
}

/** The de-identified payload the model sees: the bank (ids/text/scale/sourceSet) + the procedure only. */
function buildUserPayload(procedureContext: string, bank: BankItem[]): string {
  const items = bank.map((b) => ({ id: b.id, text: b.text, scale: b.scale, sourceSet: b.sourceSet }));
  return JSON.stringify({
    procedure: procedureContext,   // procedure NAME only — no member name/uid/identifier
    max_items: ADHOC_MAX_ITEMS,
    bank: items,
  });
}

/**
 * Generate a tailored adhoc set for an unmapped series. `procedureContext` MUST be de-identified
 * (procedure name only). Returns the persisted draft, or null on any soft failure (LLM off/empty/parse
 * fail / zero valid ids) so the caller falls back to core+PREM. A missing adhoc_sets table THROWS
 * (AdhocNotMigrated) so the route can answer 503 rather than silently dropping a real generation.
 */
export async function generateAdhocSet(
  seriesId: string, individualUid: string, procedureContext: string | null, _now: string,
): Promise<AdhocDraft | null> {
  const procedure = String(procedureContext || '').trim();
  if (!procedure) return null;                    // nothing to tailor to → core+PREM
  const bank = compileItemBank();
  if (!bank.length) return null;

  const geminiModel = geminiModelFor('proms_adhoc') ?? geminiUtilityModel();   // utility tier (Flash) when Gemini is on
  const params = {
    model: TEXT_MODEL,                            // local fallback model when Gemini is off/errors
    messages: [
      { role: 'system', content: ADHOC_GEN_PROMPT },
      { role: 'user', content: buildUserPayload(procedure, bank) },
    ],
    temperature: 0,
    max_tokens: 1200,
  };

  const traceId = await startTrace('proms_adhoc_gen', { seriesId, procedure }).catch(() => undefined);
  let content = '';
  try {
    // Governed envelope (Stage 4). No promptRef: ADHOC_GEN_PROMPT is array-joined, not a
    // registry-extractable template-literal const.
    const r = await governedChat(traceId, 'proms_adhoc_gen', params, { gemini: geminiModel });
    content = r?.choices?.[0]?.message?.content || '';
  } catch {
    if (traceId) await finishTrace(traceId, 'error').catch(() => {});
    return null;                                  // model unavailable → soft-fail to core+PREM
  }

  const out = parseModelOut(content);
  const validated = validateAdhocSelection(out.selection.map((p) => p.id), bank);   // the SAFETY GATE
  if (!validated.items.length) {
    if (traceId) { await logEvent(traceId, 'note', 'proms_adhoc_gen', { emptyAfterValidation: true, rawIds: out.selection.map((p) => p.id) }).catch(() => {}); await finishTrace(traceId, 'partial').catch(() => {}); }
    return null;                                  // no bank item survived → core+PREM
  }

  const rationaleById = new Map(out.selection.map((p) => [p.id, p.rationale ?? null]));
  const byId = bankById(bank);
  const itemIds = validated.items.map((i) => i.id);
  const items: AdhocDraftItem[] = itemIds.map((id) => {
    const b = byId.get(id)!;
    return { id: b.id, text: b.text, scale: b.scale, sourceSet: b.sourceSet, escalation: b.escalation, rationale: rationaleById.get(id) ?? null };
  });

  const id = adhocSetIdForSeries(seriesId);
  await upsertDraftAdhocSet({                     // throws AdhocNotMigrated → route maps to 503
    id, series_id: seriesId, individual_uid: individualUid,
    item_ids: itemIds, generated_item_ids: itemIds, procedure_context: procedure, gen_version: ADHOC_GEN_VERSION,
  });
  if (traceId) { await logEvent(traceId, 'note', 'proms_adhoc_gen', { selected: itemIds, gaps: out.gaps }).catch(() => {}); await finishTrace(traceId, 'success').catch(() => {}); }

  return { id, seriesId, status: 'draft', genVersion: ADHOC_GEN_VERSION, items, gaps: out.gaps };
}
