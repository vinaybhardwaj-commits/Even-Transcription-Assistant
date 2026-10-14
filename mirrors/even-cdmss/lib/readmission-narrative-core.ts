/**
 * lib/readmission-narrative-core.ts — PURE cores for the R4 case page
 * (CDMSS-READMISSIONS-R4-PRD v1.0, 18 Aug 2026): the stored audit-time narrative with
 * CODE-ENFORCED citations, the relevance-filtered "prior findings related to this return"
 * section with the DENOMINATOR rule, and the three-hop identity-join helpers measured in
 * CDMSS-TWIN-PRESTUDY-OPD-READMIT-18-AUG-2026.
 *
 * No DB, no model, no React, no clock. Everything here is testable against a table of cases:
 *   · the model PROPOSES a narrative and a selection; CODE DECIDES what is stored as valid
 *     and what is ever rendered (R4-4 / R4-5, fail closed);
 *   · the LVC section always states "N of this patient's M OPD notes have been audited"
 *     (R4-6) — silence is never mistaken for clean care;
 *   · a join failure at any hop is its own state (R4-7), never an empty list.
 *
 * Nothing here is written by a page request: these shapes are produced ONCE at audit time
 * (or by the backfill tick on the Bedrock rails) and stored on the finding blob (§2).
 */

import type { EvidenceItem, EvidenceWeight } from './readmission-reconcile-core';
import { evidenceWeight } from './readmission-reconcile-core';
import { canonicalByUid } from './audit-canonical';

// ── versions + the ONE narrative model (R4-11) ───────────────────────────────────────

export const NARRATIVE_VERSION = 'narrative/1';
export const LEDGER_VERSION = 'ledger/1';
export const RELATED_LVC_VERSION = 'related-lvc/1';
/** R4-11: the narrative is written by Opus 4.6 on Bedrock EVERYWHERE — backfill and new
 *  audits alike. Provider + model are stamped on every stored narrative; a run on the rails
 *  that names any other model is refused, never downgraded. */
export const NARRATIVE_MODEL_ID = 'global.anthropic.claude-opus-4-6-v1';
export const NARRATIVE_MODEL = `bedrock:${NARRATIVE_MODEL_ID}`;
export const NARRATIVE_PROVIDER = 'bedrock';
/** R4-3: the narrative leg's OWN budget — one try, ≤ 80 s. */
export const NARRATIVE_BUDGET_MS = 80_000;
export const NARRATIVE_MAX_TRIES = 1;
/** Carried S2 rule: Opus runs are paced at ≤ 2 findings per tick. */
export const NARRATIVE_MAX_PER_TICK = 2;

// ── stored shapes (blob-only, §2) ─────────────────────────────────────────────────────

/** One row of the evidence ledger the page renders and the narrative cites. The text is
 *  the DE-IDENTIFIED catalog text (assemble.ts is the choke point); `weight` is the
 *  reconciler's own reading of the item so the page and the audit can never disagree. */
export interface LedgerEntry {
  id: string;
  source: EvidenceItem['source'];
  side: 'index' | 'readmit' | null;
  at: string | null;
  weight: EvidenceWeight;
  text: string;
  abnormal?: boolean | null;
}
export interface EvidenceLedger {
  version: typeof LEDGER_VERSION;
  items: LedgerEntry[];
  generatedAt: string;
  /** 'audit' = the catalog the recon legs actually read; 'reassembled' = rebuilt by the
   *  backfill tick from db13 (no recon legs). Ids are consistent WITHIN a ledger by
   *  construction; a reassembled ledger may not renumber identically to the audit's. */
  source: 'audit' | 'reassembled';
}

export interface CaseNarrative {
  version: typeof NARRATIVE_VERSION;
  /** The model's prose with inline [S4]-style markers — stored even when invalid (for review). */
  text: string;
  /** Every id the markers name, deduped, in order of first appearance. */
  citedIds: string[];
  /** Ids that resolve to NO ledger entry. Non-empty ⇒ valid:false. */
  invalidIds: string[];
  /** CODE's verdict on citation integrity (R4-4). false ⇒ never rendered, flagged for review. */
  valid: boolean;
  /** Why it is invalid, in one token — for the review queue and the report. */
  invalidReason: 'none' | 'empty' | 'no_citations' | 'unresolved_ids' | null;
  generatedAt: string;
  model: string;
  provider: string;
  traceId: string | null;
  /** 'refresh' (R4.1): rewritten by the template-refresh run after a re-analysis on Opus. */
  source: 'audit' | 'backfill' | 'refresh';
  /** Addendum A1: on the REBUILT-ledger path, how many stored audit-time evidence ids (omission /
   *  exculpatory / weakest-step / refusal references) were dropped from the prompt input because
   *  the rebuilt ledger no longer carries them. 0 on the inline path (its ledger IS the audit's). */
  staleIdsDropped: number;
}

export type RelatedLvcState = 'present' | 'none_related' | 'no_audited_artefacts' | 'join_failed';
export type ReviewStatus = 'unreviewed' | 'true_positive' | 'nitpick' | 'false' | 'contested';

export interface RelatedLvcItem {
  noteUid: string;
  noteDate: string | null;
  /** The finding's concept LABEL (subject / lvc_category) — never note text (v1 rule). */
  concept: string;
  lvcCategory: string | null;
  engineVersion: string | null;
  reviewStatus: ReviewStatus;
  /** The model's stated reason this prior finding relates to the return. */
  reason: string;
  /** The prior finding's own reference (finding_ref) — one end of the citation. */
  priorEvidence: string;
  /** The readmission ledger ids it connects to — the other end. Code-verified. */
  readmitEvidenceIds: string[];
}

export interface RelatedLvc {
  version: typeof RELATED_LVC_VERSION;
  state: RelatedLvcState;
  /** THE DENOMINATOR (R4-6): N audited of M OPD notes before the readmission. */
  audited: number;
  totalNotes: number;
  items: RelatedLvcItem[];
  /** How many candidates the model proposed that CODE dropped (unverifiable ends). */
  droppedProposals: number;
  /** Which hop failed when state is join_failed; null otherwise. */
  joinFailure: 'individual' | 'prescriptions' | 'audits' | null;
  generatedAt: string;
}

// ── the evidence ledger ────────────────────────────────────────────────────────────────

/** Catalog → ledger. Every item is citable; the weight is the reconciler's. */
export function buildLedger(items: readonly EvidenceItem[], generatedAt: string, source: EvidenceLedger['source']): EvidenceLedger {
  return {
    version: LEDGER_VERSION,
    generatedAt,
    source,
    items: items.map((i) => ({
      id: i.id,
      source: i.source,
      side: i.side ?? null,
      at: i.at ?? null,
      weight: evidenceWeight(i),
      text: i.text,
      ...(i.abnormal != null ? { abnormal: i.abnormal } : {}),
    })),
  };
}

// ── citations (R4-4) ────────────────────────────────────────────────────────────────────

/** A citation marker: `[S4]`, `[L12]`, `[OT1]`, or a comma/space list `[S4, R2, L1]`. The id
 *  grammar is the catalog's: 1–4 upper-case letters then digits. Prose in square brackets
 *  ("[PATIENT]", "[unknown]") is NOT a marker and is ignored, never counted as invalid. */
const MARKER_RE = /\[([A-Z]{1,4}\d{1,4}(?:\s*[,;/]\s*[A-Z]{1,4}\d{1,4})*)\]/g;

/** Every id named by every marker, deduped, in order of first appearance. */
export function extractCitedIds(text: string | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  if (!text) return out;
  for (const m of text.matchAll(MARKER_RE)) {
    for (const raw of m[1].split(/\s*[,;/]\s*/)) {
      const id = raw.trim();
      if (id && !seen.has(id)) { seen.add(id); out.push(id); }
    }
  }
  return out;
}

export interface CitationVerdict {
  valid: boolean;
  citedIds: string[];
  invalidIds: string[];
  reason: CaseNarrative['invalidReason'];
}

/**
 * CODE DECIDES (R4-4). Fail closed:
 *   · empty / whitespace text            → invalid, 'empty'
 *   · text with NO marker at all         → invalid, 'no_citations' — an uncited account is
 *                                          unverifiable, which is exactly what the page refuses
 *   · any marker id not in the ledger    → invalid, 'unresolved_ids' (all offenders listed)
 *   · otherwise                          → valid
 * A narrative against an EMPTY ledger can therefore never be valid (every marker is unresolved).
 */
export function validateCitations(text: string | null | undefined, ledgerIds: Iterable<string>): CitationVerdict {
  const t = (text ?? '').trim();
  if (!t) return { valid: false, citedIds: [], invalidIds: [], reason: 'empty' };
  const cited = extractCitedIds(t);
  if (!cited.length) return { valid: false, citedIds: [], invalidIds: [], reason: 'no_citations' };
  const known = new Set(ledgerIds);
  const invalid = cited.filter((id) => !known.has(id));
  if (invalid.length) return { valid: false, citedIds: cited, invalidIds: invalid, reason: 'unresolved_ids' };
  return { valid: true, citedIds: cited, invalidIds: [], reason: 'none' };
}

/** Assemble the stored narrative object from the model text + code's verdict. */
export function buildCaseNarrative(args: {
  text: string; ledgerIds: Iterable<string>; generatedAt: string; model: string; provider: string;
  traceId: string | null; source: CaseNarrative['source']; staleIdsDropped?: number;
}): CaseNarrative {
  const v = validateCitations(args.text, args.ledgerIds);
  return {
    version: NARRATIVE_VERSION,
    text: (args.text ?? '').trim(),
    citedIds: v.citedIds,
    invalidIds: v.invalidIds,
    valid: v.valid,
    invalidReason: v.reason,
    generatedAt: args.generatedAt,
    model: args.model,
    provider: args.provider,
    traceId: args.traceId,
    source: args.source,
    staleIdsDropped: Math.max(0, Math.trunc(Number(args.staleIdsDropped ?? 0)) || 0),
  };
}

// ── Addendum A1: the stale-id filter for a REBUILT ledger ─────────────────────────────────
//
// The backfill re-assembles the evidence from db13; its ledger is consistent WITHIN itself, but
// the audit-time finding carries evidence ids minted against the ORIGINAL catalog. If a stored id
// (an omission's evidenceIds, an exculpatory item's corroboratingIds, an id-shaped mention inside
// the weakest-step or a refusal note) survives into the prompt while the rebuilt ledger numbers
// that item differently, the model could cite it and code would mark it valid — pointing at the
// wrong item. So on the rebuilt path every id-shaped reference is filtered to ids the rebuilt
// ledger actually has, BEFORE the model sees it, and the count is stored (staleIdsDropped).

/** The catalog id grammar (the same as the citation marker's). */
const ID_TOKEN_RE = /^[A-Z]{1,4}\d{1,4}$/;

/** Keep only ids the ledger has. PURE. */
export function filterStaleIds(ids: ReadonlyArray<string | null | undefined>, ledgerIds: Iterable<string>): { kept: string[]; dropped: number } {
  const known = new Set(ledgerIds);
  const kept: string[] = [];
  let dropped = 0;
  for (const raw of ids) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id) continue;
    if (known.has(id)) kept.push(id); else dropped++;
  }
  return { kept, dropped };
}

/** Remove bracketed id-shaped markers the ledger does not have from a free-text field (weakest
 *  step, a refusal note, an omission claim); prose in brackets is untouched. PURE. */
export function scrubStaleIdMentions(text: string | null | undefined, ledgerIds: Iterable<string>): { text: string | null; dropped: number } {
  if (!text) return { text: text ?? null, dropped: 0 };
  const known = new Set(ledgerIds);
  let dropped = 0;
  const out = text.replace(MARKER_RE, (whole, list: string) => {
    const ids = list.split(/\s*[,;/]\s*/).map((x) => x.trim()).filter(Boolean);
    const kept = ids.filter((id) => ID_TOKEN_RE.test(id) && known.has(id));
    dropped += ids.length - kept.length;
    return kept.length ? `[${kept.join(', ')}]` : '';
  }).replace(/\s{2,}/g, ' ').trim();
  return { text: out, dropped };
}

/** The page's rendering rule (R4-4): only a VALID narrative is shown. Everything else is
 *  the "no account" state — the reason tells the reviewer why. */
export function renderableNarrative(n: CaseNarrative | null | undefined): CaseNarrative | null {
  return n && n.valid === true && n.text.trim() !== '' ? n : null;
}

/** Split narrative text into prose runs and marker runs for the page to link. PURE. */
export type NarrativeSegment = { kind: 'text'; text: string } | { kind: 'cite'; ids: string[]; raw: string };
export function segmentNarrative(text: string): NarrativeSegment[] {
  const out: NarrativeSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(MARKER_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ kind: 'text', text: text.slice(last, idx) });
    out.push({ kind: 'cite', ids: m[1].split(/\s*[,;/]\s*/).map((s) => s.trim()).filter(Boolean), raw: m[0] });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

// ── the three-hop join helpers (pre-study, VALIDATED) ──────────────────────────────────

/** Legacy prescriptions with UUID-form ids are STRUCTURALLY unjoinable to audits (pre-study
 *  finding 4) — they are excluded from the note universe, never counted as "un-audited". */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuidForm(id: string | null | undefined): boolean {
  return typeof id === 'string' && UUID_RE.test(id.trim());
}

/** The UHID candidates for hop 3, as given: BOTH live formats (`UHID-nnnnnn`, `AH2526/nnnnnn`)
 *  pass through untouched — code must not assume the prefix (pre-study finding 3). Trim,
 *  dedup, drop empties and anything that is not an id shape. Matching is EXACT, downstream. */
const UHID_SHAPE = /^[A-Za-z0-9/_-]{2,40}$/;
export function uhidCandidates(uhids: ReadonlyArray<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of uhids) {
    const u = typeof raw === 'string' ? raw.trim() : '';
    if (!u || !UHID_SHAPE.test(u) || seen.has(u)) continue;
    seen.add(u); out.push(u);
  }
  return out;
}

/** One prescription document from hop 2 (uid = the audit store's `uid`). */
export interface PriorNote { uid: string; createdAt: string | null }

/** Hop 2 hygiene: drop UUID-form ids, dedup, keep only notes dated BEFORE the readmission
 *  (R4-5 — "dated before the readmission"; an undated note is kept, flagged nowhere, because
 *  dropping it would silently shrink the denominator). */
export function priorNoteUniverse(notes: readonly PriorNote[], readmitAt: string | null | undefined): PriorNote[] {
  const cutoff = readmitAt ? Date.parse(/^\d{4}-\d{2}-\d{2} /.test(readmitAt) ? readmitAt.replace(' ', 'T') : readmitAt) : NaN;
  const out: PriorNote[] = [];
  const seen = new Set<string>();
  for (const n of notes) {
    const uid = (n.uid ?? '').trim();
    if (!uid || isUuidForm(uid) || seen.has(uid)) continue;
    if (Number.isFinite(cutoff) && n.createdAt) {
      const t = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(n.createdAt) ? n.createdAt.replace(' ', 'T') : n.createdAt);
      if (Number.isFinite(t) && t >= cutoff) continue;
    }
    seen.add(uid); out.push({ uid, createdAt: n.createdAt ?? null });
  }
  return out;
}

/** One audit row of `opd_note_audits`, as hop 1 reads it (LVC fields + concepts only). */
export interface AuditRow {
  auditId: string;
  uid: string;
  auditedAt: string | null;
  engineVersion: string | null;
  /** The grader — read by the canonical rule (cloud-vs-local, reference-vs-candidate tiers). */
  model: string | null;
  noteDate: string | null;
  doctorUid: string | null;
  findings: AuditFinding[];
}
export interface AuditFinding {
  subject: string;
  verdict: string;
  lvcCategory: string | null;
  signalType: string | null;
  findingRef: string | null;
  /** The finding's rationale — MODEL INPUT ONLY after deidText; never rendered (v1). */
  rationale: string | null;
}

/**
 * Pre-study finding 2: re-audits inflate counts 1.68× and 8.6% of notes flip LVC status between
 * engine versions — ONLY ONE audit per note may count. WHICH one is the repo's ratified canonical
 * rule (lib/audit-canonical.ts, one rule with a SQL twin): cloud grader before local, highest
 * engine version (numeric), reference model before candidate, then latest audited_at. That is the
 * pre-study's "latest audit per note" as this codebase already defines it for every dashboard —
 * a bare "greatest audited_at" would let a re-run of an OLD engine version outrank the current one.
 * Mini/qwen backfill rows are excluded before ranking (the rule's default).
 */
export function latestAuditPerNote(rows: readonly AuditRow[]): AuditRow[] {
  const candidates = rows.filter((r) => !!r.uid).map((r) => ({ row: r, uid: r.uid, engine_version: r.engineVersion, model: r.model, audited_at: r.auditedAt }));
  return canonicalByUid(candidates).map((c) => c.row)
    .sort((a, b) => (Date.parse(a.noteDate ?? '') || 0) - (Date.parse(b.noteDate ?? '') || 0));
}

/** The LVC candidates the model is shown (R4-5): only LOW-VALUE verdict findings from the
 *  latest audit of each prior note. `key` is what the model must cite (`noteUid#findingRef`). */
export interface LvcCandidate {
  key: string;
  noteUid: string;
  noteDate: string | null;
  engineVersion: string | null;
  finding: AuditFinding;
  reviewStatus: ReviewStatus;
}
export function lvcCandidates(latest: readonly AuditRow[], reviewByAuditFinding: ReadonlyMap<string, ReviewStatus>): LvcCandidate[] {
  const out: LvcCandidate[] = [];
  for (const r of latest) {
    r.findings.forEach((f, i) => {
      if (f.verdict !== 'low-value') return;
      const ref = f.findingRef ?? `idx${i}`;
      out.push({
        key: `${r.uid}#${ref}`,
        noteUid: r.uid,
        noteDate: r.noteDate,
        engineVersion: r.engineVersion,
        finding: f,
        reviewStatus: reviewByAuditFinding.get(`${r.auditId}#${f.findingRef ?? ''}`) ?? 'unreviewed',
      });
    });
  }
  return out;
}

/** The latest scope='finding' feedback verdict → the stamped review status (R4-6). */
export function toReviewStatus(verdict: string | null | undefined): ReviewStatus {
  switch (verdict) {
    case 'true_positive': case 'nitpick': case 'false': case 'contested': return verdict;
    default: return 'unreviewed';
  }
}

// ── the relatedLvc reducer (R4-5 / R4-6 / R4-7) — all four states + the denominator ────────

/** What the model proposed for one candidate. */
export interface RelatedProposal { key: string; reason: string; readmitEvidenceIds: string[] }

export function reduceRelatedLvc(args: {
  /** null = the join failed at `joinFailure` (R4-7). */
  join: { totalNotes: number; audited: number; candidates: LvcCandidate[] } | null;
  joinFailure?: RelatedLvc['joinFailure'];
  proposals: readonly RelatedProposal[];
  ledgerIds: Iterable<string>;
  generatedAt: string;
}): RelatedLvc {
  const base = { version: RELATED_LVC_VERSION as typeof RELATED_LVC_VERSION, generatedAt: args.generatedAt };
  if (!args.join) {
    return { ...base, state: 'join_failed', audited: 0, totalNotes: 0, items: [], droppedProposals: 0, joinFailure: args.joinFailure ?? 'individual' };
  }
  const { totalNotes, audited, candidates } = args.join;
  if (audited <= 0 || !candidates.length) {
    // No audited artefact at all, or audited notes with no LVC finding: the honest state is
    // decided by the DENOMINATOR, never by an empty proposal list.
    return { ...base, state: audited <= 0 ? 'no_audited_artefacts' : 'none_related', audited, totalNotes, items: [], droppedProposals: args.proposals.length, joinFailure: null };
  }
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const known = new Set(args.ledgerIds);
  const items: RelatedLvcItem[] = [];
  let dropped = 0;
  const used = new Set<string>();
  for (const p of args.proposals) {
    const c = byKey.get((p.key ?? '').trim());
    // Both ends verified by CODE: the prior finding must be one we showed, and every readmit
    // id it names must be a real ledger entry. Anything else is dropped, never rendered.
    const ids = Array.from(new Set((p.readmitEvidenceIds ?? []).map((s) => String(s).trim()).filter(Boolean)));
    if (!c || used.has(c.key) || !ids.length || ids.some((id) => !known.has(id)) || !(p.reason ?? '').trim()) { dropped++; continue; }
    used.add(c.key);
    items.push({
      noteUid: c.noteUid,
      noteDate: c.noteDate,
      concept: c.finding.subject,
      lvcCategory: c.finding.lvcCategory,
      engineVersion: c.engineVersion,
      reviewStatus: c.reviewStatus,
      reason: p.reason.trim().slice(0, 600),
      priorEvidence: c.finding.findingRef ?? c.key,
      readmitEvidenceIds: ids,
    });
  }
  return { ...base, state: items.length ? 'present' : 'none_related', audited, totalNotes, items, droppedProposals: dropped, joinFailure: null };
}

/** The denominator sentence (R4-6) — rendered on EVERY LVC section, whatever the state. */
export function denominatorLine(r: Pick<RelatedLvc, 'state' | 'audited' | 'totalNotes'>): string {
  if (r.state === 'join_failed') return 'unknown — records could not be joined';
  return `${r.audited} of this patient's ${r.totalNotes} OPD note${r.totalNotes === 1 ? '' : 's'} before this readmission ${r.audited === 1 ? 'has' : 'have'} been audited`;
}

/** The section's one-line state copy. */
export function relatedLvcCopy(r: { state: RelatedLvcState; items: readonly unknown[] }): string {
  switch (r.state) {
    case 'present': return `${r.items.length} prior finding${r.items.length === 1 ? '' : 's'} related to this return`;
    case 'none_related': return 'No prior finding relates to this return — among the notes that were audited';
    case 'no_audited_artefacts': return 'No audited OPD artefacts for this patient — absence of flags is not clean care';
    case 'join_failed': return 'unknown — records could not be joined';
  }
}

// ── the case blob: what the page reads (§2) — tolerant, all optional ───────────────────────

export interface CaseArtefacts {
  evidenceLedger?: EvidenceLedger | null;
  caseNarrative?: CaseNarrative | null;
  relatedLvc?: RelatedLvc | null;
}

/** The list route emits the finding blob per card; the ledger and narrative text would make it
 *  heavy for nothing (the card renders neither). Strip them, keep the small facts. PURE. */
export function stripCaseArtefacts<T extends { evidenceLedger?: unknown; caseNarrative?: { text?: string } | null }>(blob: T | null): T | null {
  if (!blob) return blob;
  const out = { ...blob };
  delete out.evidenceLedger;
  if (out.caseNarrative) out.caseNarrative = { ...out.caseNarrative, text: '' };   // renderableNarrative() → null on a stripped copy
  return out;
}
