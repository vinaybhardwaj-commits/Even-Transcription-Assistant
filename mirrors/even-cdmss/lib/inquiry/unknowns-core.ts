// lib/inquiry/unknowns-core.ts — Inquiry engine (inquiry/0.1), pure unknown derivation
// (Inquiry PRD §4). ADVISORY PLANE: derives a member's load-bearing unknowns as a recomputable
// projection over existing evidence — computed at read time, never stored as new state (D3).
// No LLM, no I/O, no Date.now (`now` is PASSED IN). Identical inputs ⇒ identical output order.
//
// Import discipline (architecture rule 5): VALUE imports are limited to the spine read layer
// (present-augment), the member-state normalizer (normalize-core — not a scored core; B5 keys
// new_medication the same way member-reconcile keys meds) and the frozen care-call floor — never
// a scored core. Intra-inquiry imports are type-only throughout lib/inquiry (rule 5 is a
// valueOnly rule over both directions).

import type { ClinicalState } from '../clinical-state/schema';
import type { MemberStateSnapshot } from '../member-state/schema';
import type { DeidOpdCase, OpdMed } from '../opd-ingest-core';
import { computeCareGaps } from '../member-state/present-augment';
import { normalizeConcept, groupingKey } from '../member-state/normalize-core';
import { followUpSubjects } from '../care-call-core';

export type UnknownKind =
  | 'unknown_finding'      // clinicalState.unknowns[] entries
  | 'missing_critical'     // clinicalState.missingCriticalData[] strings
  | 'instability_input'    // clinicalState.instability.missingInputs (vitals channels)
  | 'med_contradiction'    // prescribed vs patient-reported stopped/not_taking/unknown, unresolved at latest evidence
  | 'new_medication'       // episode med ABSENT from a non-empty snapshot's prior meds (B5 — uptake unconfirmed)
  | 'care_gap'             // computeCareGaps output (abnormal + stale)
  | 'followup_open'        // followUpSubjects()-style open follow-up with no committed action
  | 'allergy_unconfirmed'; // allergy field blank on the note (mirrors ask-set/0.1 trigger)

export interface UnknownItem {
  id: string;                    // deterministic: `unk-${kind}:${slug(subject)}` (djb2 suffix on collision)
  kind: UnknownKind;
  subject: string;               // med label / complaint / analyte / channel
  detail: string;                // human-readable, from source (e.g. CareGap.detail verbatim)
  criticality: 'safety' | 'review' | 'info';
  sourceRefs: string[];          // finding ids / assertion ids / analyteIds / 'note:allergies' — typed pointers, no ontology
  stateRef: { kind: 'member' | 'episode'; version: string; computedAt: string | null };
}

export interface DeriveUnknownsInput {
  episode?: DeidOpdCase | null;
  clinicalState?: ClinicalState | null;
  snapshot?: MemberStateSnapshot | null;
  now: string;
}

// Deliberately identical to care-call-core's slug (not exported there; the frozen floor is never
// edited) so `${family}:${slug(subject)}` candidate ids line up with buildAskSet's ask ids.
export const slug = (s: string): string =>
  (s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'x';

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/** Loose token overlap: any ≥4-char token shared between the two strings (case-insensitive). */
export function tokenOverlap(a: string, b: string): boolean {
  const toks = (x: string) => new Set((x || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 4));
  const ta = toks(a);
  for (const t of toks(b)) if (ta.has(t)) return true;
  return false;
}

const CRIT_RANK: Record<UnknownItem['criticality'], number> = { safety: 0, review: 1, info: 2 };

/** Is any episode med matching this subject an ISMP high-alert med? (drives criticality only). */
function isHighAlertSubject(subject: string, episode: DeidOpdCase | null | undefined): boolean {
  for (const m of episode?.medications ?? []) {
    if (!m.highAlert) continue;
    const label = [m.generic, m.brand, m.resolvedGeneric].filter(Boolean).join(' ');
    if (tokenOverlap(label, subject)) return true;
  }
  return false;
}

// Deliberately identical to care-call-core's medLabel (not exported there; the frozen floor is
// never edited) so a new_medication subject slugs to the SAME `MED_STATUS:${slug(label)}` id as
// buildAskSet's med ask — candidatesFromUnknowns then MERGES them instead of serving duplicates.
const medLabel = (m: OpdMed): string => {
  const g = (m.generic || '').trim(); const b = (m.brand || '').trim(); const s = (m.strength || '').trim();
  const brandPart = b ? ` (${b}${s ? ` ${s}` : ''})` : (s ? ` (${s})` : '');
  return `${g || b || 'medication'}${g ? brandPart : ''}`.trim();
};

/**
 * Pure derivation: state(s) → UnknownItem[] (Inquiry PRD §4). Mapping is total and
 * side-effect-free; every item carries ≥1 sourceRef; snapshot absent ⇒ member-derived kinds
 * simply absent (episode-only degradation, D14). Stable sort: criticality, then kind, then subject.
 */
export function deriveUnknowns(input: DeriveUnknownsInput): UnknownItem[] {
  const { episode, clinicalState, snapshot } = input;
  const items: UnknownItem[] = [];

  const episodeRef: UnknownItem['stateRef'] = {
    kind: 'episode',
    // When a ClinicalState is supplied its version is authoritative; a raw DeidOpdCase episode
    // has no schema version const — labelled honestly rather than borrowing clinical-state/1.2.
    version: clinicalState?.version ?? 'opd-ingest/deid-opd-case',
    computedAt: episode?.noteDate ?? null,
  };
  const memberRef: UnknownItem['stateRef'] | null = snapshot
    ? { kind: 'member', version: String(snapshot.version), computedAt: snapshot.computedAt ?? null }
    : null;

  const push = (x: Omit<UnknownItem, 'id'>) => {
    if (!x.sourceRefs.length || !x.subject) return;   // every UnknownItem MUST carry ≥1 sourceRef
    const base = `unk-${x.kind}:${slug(x.subject)}`;
    const id = items.some((i) => i.id === base) ? `${base}-${djb2(x.detail)}` : base;
    if (items.some((i) => i.id === id)) return;       // fully identical duplicate → keep first
    items.push({ id, ...x });
  };

  // ── episode/clinical-state kinds ──
  for (const f of clinicalState?.unknowns ?? []) {
    push({
      kind: 'unknown_finding', subject: f.concept,
      detail: (f.provenance?.rawText || '').trim() || `${f.concept} — status unknown on the note`,
      criticality: 'review', sourceRefs: [f.id], stateRef: episodeRef,
    });
  }
  for (const s of clinicalState?.missingCriticalData ?? []) {
    const t = String(s || '').trim();
    if (!t) continue;
    push({
      kind: 'missing_critical', subject: t, detail: t,
      criticality: 'review', sourceRefs: ['clinical-state:missingCriticalData'], stateRef: episodeRef,
    });
  }
  for (const ch of clinicalState?.instability?.missingInputs ?? []) {
    push({
      kind: 'instability_input', subject: ch,
      detail: `${ch} not recorded — stability not assessable on this channel`,
      criticality: 'info', sourceRefs: ['clinical-state:instability.missingInputs'], stateRef: episodeRef,
    });
  }

  // ── member-derived kinds (snapshot present only) ──
  if (snapshot && memberRef) {
    // med_contradiction (a): open medication-domain discrepancies from the frozen reconciliation.
    const seenMedSubjects = new Set<string>();
    for (const c of snapshot.conflicts ?? []) {
      if (c.domain !== 'medication') continue;
      const first = c.assertions?.[0]?.detail ?? '';
      const subject = (first.split(':')[0] || '').trim() || 'medication';
      seenMedSubjects.add(slug(subject));
      push({
        kind: 'med_contradiction', subject,
        detail: (c.assertions ?? []).map((a) => a.detail).join(' · ') || 'medication status conflict',
        criticality: isHighAlertSubject(subject, episode) ? 'safety' : 'review',
        sourceRefs: [c.id, ...(c.assertions ?? []).map((a) => a.encounterRef)].filter(Boolean),
        stateRef: memberRef,
      });
    }
    // med_contradiction (b): reconciled currentness stopped/not_taking/unknown with no conflict row
    // (e.g. a lone patient-reported 'unknown' — still unresolved at latest evidence).
    for (const m of snapshot.medications ?? []) {
      if (!['stopped', 'not_taking', 'unknown'].includes(m.status)) continue;
      const subject = m.normalizedConcept?.raw || '';
      if (!subject || seenMedSubjects.has(slug(subject))) continue;
      push({
        kind: 'med_contradiction', subject,
        detail: `prescribed but patient-reported ${m.status} — unresolved at latest evidence`,
        criticality: isHighAlertSubject(subject, episode) ? 'safety' : 'review',
        sourceRefs: (m.occurrences ?? []).map((o) => o.encounterRef).filter(Boolean).slice(-3).length
          ? (m.occurrences ?? []).map((o) => o.encounterRef).filter(Boolean).slice(-3)
          : [`member:medication:${slug(subject)}`],
        stateRef: memberRef,
      });
    }
    // new_medication (B5 ruling): an episode med ABSENT from the snapshot's prior meds — the
    // doctor just started it, so confirming uptake gets its own ladder rung. DETERMINISTIC and
    // member-derived: keyed via normalizeConcept→groupingKey, the same keying member-reconcile
    // uses — never note-text parsing. ONLY against a NON-EMPTY prior med list (a thin/empty
    // snapshot cannot tell "new" from "unknown" → derive nothing, episode-only degradation).
    const priorMeds = snapshot.medications ?? [];
    if (priorMeds.length && episode) {
      const priorKeys = new Set<string>();
      for (const m of priorMeds) {
        if (m.normalizedConcept) priorKeys.add(groupingKey(m.normalizedConcept));
        const raw = m.normalizedConcept?.raw || '';
        // re-key the raw too: normalizer-version drift in a stored concept must never flag "new"
        if (raw) priorKeys.add(groupingKey(normalizeConcept(raw, 'medication')));
      }
      for (const m of episode.medications ?? []) {
        if (m.highAlert) continue;                        // high-alert wins rank 0 anyway — no redundant unknown
        const raw = (m.generic || m.brand || '').trim();  // aggregate-core's keying precedence
        if (!raw || priorKeys.has(groupingKey(normalizeConcept(raw, 'medication')))) continue;
        const subject = medLabel(m);
        push({
          kind: 'new_medication', subject,
          detail: `doctor started ${subject} — not in prior records`,
          criticality: 'review',
          sourceRefs: [`episode:medication:${slug(subject)}`],
          stateRef: memberRef,
        });
      }
    }
    // care_gap: the spine read layer's own arithmetic — detail carried VERBATIM.
    for (const g of computeCareGaps(snapshot.investigations ?? [], snapshot.medications ?? [], input.now)) {
      push({
        kind: 'care_gap', subject: g.analyte, detail: g.detail,
        criticality: g.severity, sourceRefs: [g.analyteId], stateRef: memberRef,
      });
    }
  }

  // ── episode kinds from the raw case (mirror the ask-set/0.1 triggers — reused, not forked) ──
  if (episode) {
    for (const s of followUpSubjects(episode)) {
      const committed = (snapshot?.followUps ?? []).some((fu) =>
        ['committed', 'already_done_inhouse', 'already_done_outside'].includes(fu.action) && tokenOverlap(fu.subject, s));
      if (committed) continue;
      push({
        kind: 'followup_open', subject: s, detail: `open follow-up with no committed action: ${s}`,
        criticality: 'review', sourceRefs: ['note:advice'], stateRef: episodeRef,
      });
    }
    const allergyBlank = !episode.allergies || !String(episode.allergies).trim();
    if (allergyBlank) {
      push({
        kind: 'allergy_unconfirmed', subject: 'allergies',
        detail: 'allergy field blank on the note — never confirmed with the patient',
        criticality: 'review', sourceRefs: ['note:allergies'], stateRef: episodeRef,
      });
    }
  }

  return items.sort((a, b) =>
    (CRIT_RANK[a.criticality] - CRIT_RANK[b.criticality])
    || a.kind.localeCompare(b.kind)
    || a.subject.localeCompare(b.subject));
}
