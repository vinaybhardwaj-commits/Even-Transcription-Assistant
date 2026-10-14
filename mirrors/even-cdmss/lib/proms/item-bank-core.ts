// lib/proms/item-bank-core.ts — PROMs Tier-3 pure substrate (prom-item-bank/0.1). Compiles the
// house-item bank from the frozen catalog: the deduped union of every hs-sets/0.2 HOUSE_SET item,
// house-only (EXCLUDES every validated instrument AND the PREM module — those never enter the bank).
// Pure + deterministic: no Date.now, no randomness, no DB, no LLM. A derivation of HOUSE_SETS only.

import { HOUSE_SETS, type Item, type Scale } from './catalog';

export const PROM_ITEM_BANK_VERSION = 'prom-item-bank/0.1' as const;

/** One bank item: the verbatim catalog item plus the id of the hs-set it was harvested from. */
export interface BankItem {
  id: string;
  text: string | null;
  scale: Scale;
  escalation: string | null;
  sourceSet: string;   // the HOUSE_SETS key this item came from
}

/** Compile the house-item bank = deduped union of ALL hs-sets/0.2 HOUSE_SET items, in catalog order
 *  (insertion order of HOUSE_SETS, then item order within each set). First occurrence of an id wins.
 *  House-only by construction — HOUSE_SETS never contains a validated instrument or the PREM module.
 *  Deterministic: same input → deep-equal output every call. */
export function compileItemBank(): BankItem[] {
  const bank: BankItem[] = [];
  const seen = new Set<string>();
  for (const [sourceSet, def] of Object.entries(HOUSE_SETS)) {
    for (const it of def.items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      bank.push({ id: it.id, text: it.text, scale: it.scale, escalation: it.escalation ?? null, sourceSet });
    }
  }
  return bank;
}

/** Convenience: the bank keyed by item id (first-wins), for O(1) lookup by validators/scorers. */
export function bankById(bank: BankItem[]): Map<string, BankItem> {
  const m = new Map<string, BankItem>();
  for (const b of bank) if (!m.has(b.id)) m.set(b.id, b);
  return m;
}

/** A bank item is structurally an Item (id/text/scale/escalation) — usable directly by scoreHouseItems. */
export function toItem(b: BankItem): Item {
  return { id: b.id, text: b.text, scale: b.scale, escalation: b.escalation };
}
