/**
 * lib/cdsco-banned-fdc-core.ts — CDSCO banned fixed-dose-combination check (PURE).
 * PRD CDMSS-CDSCO-BANNED-FDC (C1–C9). No db / Next imports; loads under strip-types for tests.
 *
 * A prescription whose molecule set EXACTLY equals a combination prohibited under Section 26A of
 * the Drugs and Cosmetics Act 1940 (per the curated, pharmacist-reviewed gazette seed —
 * data/cdsco-banned-fdc.json, injected here) emits a deterministic prescribing_safety finding at
 * verdict 'low-value', confidence 1.0 (C1/C5/C6).
 *
 * MATCHING (C5): exact molecule-SET equality only. medMolecules() (the existing splitter — never a
 * second splitter) → lowercase, trim, drop empties, dedupe, SORT; compare against the entry's
 * `molecules` (canonicalised the same way defensively, though the seed is compiled lowercase+sorted).
 * A superset does NOT fire; a subset does NOT fire; no fuzzy or synonym matching, ever.
 *
 * NEAR-MISSES (DETERMINISM-TRIO PRD v1.0 §3, 8 Aug 2026): `bannedFdcNearMisses` at the foot of this
 * file counts — informationally, at confidence 0, never scoring — the products that come CLOSE to an
 * entry (one molecule extra, or one short). It exists to measure whether exact-set matching is too
 * strict. It changes nothing about the check above.
 *
 * FAIL-SAFE (PRD §7): every failure degrades to SILENCE. Malformed/empty table → []. A brand with
 * no resolvable generic has no molecule set → no finding (an accepted miss — an unresolvable brand
 * is never accused). Any exception → caught, [] returned; the audit proceeds. There is NO path
 * where this check asserts a prescription is illegal on incomplete evidence.
 */

import type { OpdMed } from './opd-ingest-core';
import { medMolecules, type OpdFinding } from './opd-note-audit-core';

// ── Injected seed table (shape of data/cdsco-banned-fdc.json, PRD §3) ─────────
export interface BannedFdcEntry {
  id: string;                       // e.g. cdsco-2026-06-11-004
  molecules: string[];              // lowercase, sorted, canonical (compile-time discipline)
  notification_date: string;        // YYYY-MM-DD gazette notification date
  gazette_ref: string;              // S.O. number
  citation_url?: string;
  statement?: string;
}
export interface BannedFdcTable {
  version: string;
  compiled_on?: string | null;
  reviewed_by?: string | null;      // C3 — pharmacist sign-off, populated before any entry ships
  entries: BannedFdcEntry[];
}

/** Canonical molecule set: lowercase, trim, drop empties, dedupe, sort. */
export function normalizeMoleculeSet(mols: string[]): string[] {
  return Array.from(new Set(mols.map((m) => String(m || '').toLowerCase().trim()).filter(Boolean))).sort();
}

/**
 * Deterministic banned-FDC findings for a prescription (C1). One finding per matched BAN ENTRY
 * (two products of the same banned combination → one finding). Emits the det() shape verbatim
 * (C6); the `Subject: detail` colon convention is load-bearing — the text before the colon is the
 * signal-type key (SIGNAL_TYPE_RULES → 'banned_fdc'), the text after feeds finding_ref.
 */
export function bannedFdcFindings(meds: OpdMed[], table: BannedFdcTable): OpdFinding[] {
  try {
    const entries = Array.isArray(table?.entries) ? table.entries : [];
    if (!entries.length || !Array.isArray(meds) || !meds.length) return [];

    // Pre-canonicalise entries; a malformed entry (no id / <2 molecules) can never fire.
    const canon = entries
      .map((e) => ({ e, key: normalizeMoleculeSet(Array.isArray(e?.molecules) ? e.molecules : []).join('|') }))
      .filter((x) => !!x.e?.id && x.key.includes('|'));   // ≥2 molecules — a single-molecule "combination" is a data error, not a ban we assert
    if (!canon.length) return [];

    const out: OpdFinding[] = [];
    const fired = new Set<string>();
    for (const m of meds) {
      const set = normalizeMoleculeSet(medMolecules(m));
      if (set.length < 2) continue;                       // single molecule can never equal a banned combination (C5)
      const key = set.join('|');
      for (const { e, key: entryKey } of canon) {
        if (key !== entryKey || fired.has(e.id)) continue;
        fired.add(e.id);
        const composition = entryKey.split('|').join(' + ');
        out.push({
          subject: `Banned fixed-dose combination: ${composition}`,
          verdict: 'low-value',                            // C6 — maximal penalty
          confidence: 1.0,                                 // C5 — exact match or nothing
          domain: 'prescribing_safety',
          rationale: `${composition} is prohibited for manufacture, sale and distribution in India under Section 26A of the Drugs and Cosmetics Act 1940 (gazette ${e.gazette_ref}, ${e.notification_date}).`,
          evidence: [], estimates: [], citation_ids: [],
          source: 'deterministic',
        });
      }
    }
    return out;
  } catch {
    return [];                                            // PRD §7 — never throw, never block an audit
  }
}

// ── Near-miss counter (DETERMINISM-TRIO PRD v1.0 §3, D-3, 8 Aug 2026) ─────────
//
// WHAT IT MEASURES, AND WHY IT IS NOT A SAFETY CHECK. The exact-match rule above is deliberately
// absolute: a product fires only when its molecule set EQUALS a gazette entry. That is the right
// posture for an accusation of illegality, and it is also untested — nobody knows how much real
// prescribing sits one molecule away from a prohibited combination. This counter answers that with
// data instead of opinion. Every finding it emits is INFORMATIONAL at CONFIDENCE 0: it can never
// enter a score, and its wording (fixed in PRD §3.2, not to be editorialised) says so on its face.
//
// DEFINITION (§3.1, exact). For a med molecule set S (|S| ≥ 2) and an entry set E (|E| ≥ 2):
//   · SUPERSET            S ⊋ E                        — the product is the banned combination plus more
//   · SUBSET-MISSING-ONE  S ⊊ E and |E| − |S| = 1      — one molecule short of it
// S = E is the exact match, the real finding above, and is NEVER also a near-miss — nor is any
// entry that matched exactly ANYWHERE on this note, so a note carrying both the banned product and
// a superset of it reports the ban once and does not also report a near-match to the same entry.
// |S| ≥ 2 is inherited verbatim from the exact-match check: a single-molecule product is not a
// combination, and admitting it would near-miss every two-molecule entry containing that molecule.
//
// Canonicalisation, dedupe-per-entry and the fail-safe posture are the exact-match check's, reused.

/** Noise guard (§3.2): at most this many near-miss findings per note, taken in ENTRY order — so
 *  the cap is deterministic and independent of the order the EMR listed the medications in. */
export const BANNED_FDC_NEAR_MISS_CAP = 3;

/** The near-miss closing sentence — VERBATIM from PRD §3.2. Do not editorialise. */
const NEAR_MISS_CLOSE = 'This is not the prohibited combination. Informational only — it does not affect any score. Logged to measure whether exact-match checking is too strict.';

/**
 * Informational near-miss findings for a prescription (§3.2). Never scores, never accuses:
 * verdict 'uncertain', confidence 0, informational true. The `Subject: detail` colon convention is
 * load-bearing exactly as above — the text before the colon is the signal-type key
 * (SIGNAL_TYPE_RULES → 'banned_fdc_near_miss'), and the text after it is the ENTRY composition,
 * never the product name, so finding_ref is stable across re-audits and across products.
 */
export function bannedFdcNearMisses(meds: OpdMed[], table: BannedFdcTable): OpdFinding[] {
  try {
    const entries = Array.isArray(table?.entries) ? table.entries : [];
    if (!entries.length || !Array.isArray(meds) || !meds.length) return [];

    const canon = entries
      .map((e) => ({ e, set: normalizeMoleculeSet(Array.isArray(e?.molecules) ? e.molecules : []) }))
      .filter((x) => !!x.e?.id && x.set.length >= 2);
    if (!canon.length) return [];

    // The med sets, canonicalised once (|S| ≥ 2 — see the header).
    const products = meds
      .map((m) => ({ label: m.brand || m.generic || m.resolvedGeneric || 'medication', set: normalizeMoleculeSet(medMolecules(m)) }))
      .filter((p) => p.set.length >= 2);
    if (!products.length) return [];

    // Entries that matched EXACTLY somewhere on this note — excluded from near-misses entirely.
    const exact = new Set(
      canon.filter((c) => products.some((p) => p.set.join('|') === c.set.join('|'))).map((c) => c.e.id));

    const out: OpdFinding[] = [];
    const fired = new Set<string>();
    // Entries outer, products inner: the cap and the emitted order follow the RULEBOOK, not meds[].
    for (const { e, set: E } of canon) {
      if (out.length >= BANNED_FDC_NEAR_MISS_CAP) break;
      if (exact.has(e.id) || fired.has(e.id)) continue;
      for (const p of products) {
        const S = p.set;
        const inBoth = S.filter((x) => E.includes(x));
        const superset = S.length > E.length && inBoth.length === E.length;
        const subsetMissingOne = S.length < E.length && E.length - S.length === 1 && inBoth.length === S.length;
        if (!superset && !subsetMissingOne) continue;
        fired.add(e.id);
        const composition = E.join(' + ');
        const differing = superset ? S.filter((x) => !E.includes(x)) : E.filter((x) => !S.includes(x));
        const diff = superset ? `extra: ${differing.join(', ')}` : `missing: ${differing.join(', ')}`;
        out.push({
          subject: `Near-match to a banned combination: ${composition}`,
          verdict: 'uncertain',                            // §3.2 — a count, not a judgement
          confidence: 0,                                   // §3.2 — non-scoring by construction
          domain: 'prescribing_safety',
          rationale: `${p.label} (${S.join(' + ')}) shares ${inBoth.join(', ')} with the prohibited combination ${composition} (gazette ${e.gazette_ref}, ${e.notification_date}), but differs — ${diff}. ${NEAR_MISS_CLOSE}`,
          evidence: [], estimates: [], citation_ids: [],
          source: 'deterministic',
          informational: true,                             // §3.2 — never penalises the score
        });
        break;                                             // one finding per entry (dedupe per entry id)
      }
    }
    return out;
  } catch {
    return [];                                            // §7 posture, inherited — never throw, never block
  }
}
