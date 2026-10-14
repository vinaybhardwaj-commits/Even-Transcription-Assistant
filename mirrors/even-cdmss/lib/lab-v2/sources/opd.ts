/**
 * lib/lab-v2/sources/opd.ts — the ONE production read a dataset freeze performs
 * (LAB-MCP-V2-PRD-v1.0 §8.1, §13).
 *
 * ⚠️ THIS FILE RUNS OUTSIDE ANY LAB EXECUTION CONTEXT, BY CONSTRUCTION. `dataset_create`
 * calls it before it ever enters `withLabExecution`, which is the only reason it can
 * touch `sql` and `metabaseQuery` at all — inside a context both throw LAB_IO_FORBIDDEN
 * (§7). If a future edit moves a call to `freezeOpdCase` inside a context, it will not
 * silently read the wrong thing: it will throw, loudly, which is the intent.
 *
 * FAIL-SAFE IS THE WHOLE POINT (kickoff, SQL/SCHEMA HONESTY (a)). Every path here
 * degrades to a typed CASE_NOT_FOUND or SOURCE_UNAVAILABLE. It never returns a partially
 * frozen case, because a dataset that silently froze `specialty: null` when the directory
 * was merely unreachable would produce a research result that differs from production for
 * a reason nobody could later reconstruct. Missing is fine; WRONG is not.
 *
 * PROVENANCE OF EVERY QUERY (reported verbatim to the orchestrator):
 *  · The note itself and the complexity bundle are read through the EXISTING, live,
 *    production-validated exports of lib/metabase.ts (`fetchOpdNoteByUid`,
 *    `fetchPatientHistoryBundle`). No new db13 SQL was written or guessed: the nightly
 *    OPD worker runs these same two functions against db13 today.
 *  · The production-Neon inputs (the LVC rule snapshot, the doctor's specialty, the active
 *    suppressions and the quieting config) are read by CALLING THE EXISTING READERS —
 *    `getLvcRules` and `doctorSpecialtyFor` exported from lib/opd-note-audit.ts, and
 *    `loadActiveSuppressions` / `loadQuietingConfig` already exported from
 *    lib/audit-suppression-store.ts. This file therefore writes NO SQL AT ALL. That is deliberate twice over: the frozen value is by construction the
 *    value the audit would have read, and the repository's single inventory of
 *    lvc_recommendations SQL (lib/__tests__/rule-governance-dormancy.test.ts, proof 3)
 *    stays a true inventory instead of gaining a second copy of the same query.
 */
import { loadActiveSuppressions, loadQuietingConfig } from '../../audit-suppression-store';
import { createHash } from 'crypto';
import { fetchOpdNoteByUid, fetchPatientHistoryBundle, metabaseQuery } from '../../metabase';
import { retrieve as productionRetrieve } from '../../retrieve';
import { doctorSpecialtyFor, getLvcRules } from '../../opd-note-audit';
import { rowToOpdCase } from '../../opd-ingest-core';
import { bandFor } from '../../opd-complexity-core';
import { LabError, hash, type OpdFrozen } from '../contracts';
import { enrichOpdMeds } from '../../formulary';

// ─────────────────────────────────────────────────────────────────────────────────────
// Decision 44 — the member key
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The one db13 read this round adds. INFERRED, and it CANNOT be validated through the v1
 * `audit_query` connector, which fronts production Neon rather than db13 — it is listed verbatim
 * in the build report as unvalidated. It is not invented, though: it is the resolution
 * `fetchPatientHistoryBundle` already performs (lib/metabase.ts), whose own comment records that
 * both `uid` and `presc_uid` match on this table and that the match was validated on 8 Jul.
 */
export const MEMBER_RESOLVE_SQL = (uid: string) =>
  `SELECT individual_uid FROM dpipe_prescription_pipeline WHERE uid = '${uid}' OR presc_uid = '${uid}' LIMIT 1`;

/**
 * DECISION 44 — the member identifier is read, hashed, and DISCARDED.
 *
 * `member_key = sha256(salt || member_id)`, hex. The raw id is never returned by this function,
 * never stored in an object, and never logged: it lives in a local for the two lines between the
 * db13 read and the hash. The salt makes the key non-reversible by anyone who later obtains the
 * member list, and stable within a deployment so a cohort's clusters hold across datasets.
 *
 * ⚠️ NO SALT, NO COHORT. An unsalted hash of a member id is a rainbow-table lookup away from the
 * id itself, so a missing salt is a REFUSAL, not a fallback to an unsalted digest or to a null
 * key. Single-case mode never asks for a member key and is unaffected.
 */
export function memberSalt(): string {
  const salt = process.env.LAB_V2_MEMBER_SALT;
  if (!salt) {
    throw new LabError('NOT_CONFIGURED', 'LAB_V2_MEMBER_SALT is not set — cohort mode needs it to group by member without storing an identifier (decision 44)');
  }
  return salt;
}

export function memberKeyOf(memberId: string, salt: string): string {
  return createHash('sha256').update(`${salt}${memberId}`).digest('hex');
}

/** Resolve and hash. Returns null when db13 has no member for this note; never the raw id. */
export async function memberKeyForNote(noteUid: string): Promise<string | null> {
  const salt = memberSalt();
  let rows: Record<string, unknown>[];
  try {
    rows = await metabaseQuery(MEMBER_RESOLVE_SQL(noteUid));
  } catch (e) {
    throw new LabError('SOURCE_UNAVAILABLE', `db13 member resolution unavailable for ${noteUid}: ${(e as Error).message}`);
  }
  const raw = rows[0]?.individual_uid ? String(rows[0].individual_uid) : '';
  if (!raw) return null;
  // The only two lines the raw id exists for.
  const key = memberKeyOf(raw, salt);
  return key;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Decision 41 — the retrieval freeze
// ─────────────────────────────────────────────────────────────────────────────────────

/** §17.4 decision 41 — ids, book, chapter, source, preview, score. Nothing else. */
export interface FrozenSource {
  id: number | string;
  book: string | null;
  chapter: string | null;
  source: string | null;
  preview: string | null;
  score: number | null;
}

/**
 * The query the freeze retrieves on, mirroring lib/opd-note-audit.ts:1417 field for field, so the
 * frozen list is the list the engine's own query would have drawn. A case-level freeze, not a
 * per-query one: the adapter's edge serves this list for whatever query the engine asks, which is
 * what makes the run reproducible.
 */
export function freezeQueryFor(row: Record<string, unknown>): string {
  const { case: oc } = rowToOpdCase(row);
  enrichOpdMeds(oc.medications);
  return [
    ...oc.impressions,
    ...oc.diagnosisCodes,
    oc.reasonForConsult || '',
    ...oc.presentingComplaints.slice(0, 4),
    ...oc.medications.map((m) => m.resolvedGeneric || m.generic || m.brand || '').filter(Boolean),
    'outpatient appropriateness rational prescribing evidence-based management guideline',
  ].filter(Boolean).join('. ');
}

/**
 * DECISION 41 — the CANDIDATE STAGE ONLY: embedding and lexical, no reranker, no query expansion.
 * The same two switches `retrieval_inspect` uses and for the same reason (decision 27): both the
 * reranker and `expandQuery` are governedChat calls, and a model call at freeze time would be a
 * model call outside any run's ledger — unbudgeted, unattributed, and charged to nobody.
 */
export async function freezeSources(row: Record<string, unknown>, topK = 8): Promise<FrozenSource[]> {
  const query = freezeQueryFor(row);
  try {
    const out = await productionRetrieve(query, { topK, skipExpand: true, useReranker: false });
    return (out.hits ?? []).map((h) => ({
      id: h.id,
      book: h.book ?? null,
      chapter: h.chapter ?? null,
      source: h.source ?? null,
      preview: (h.text ?? '').slice(0, 400),
      score: typeof h.similarity === 'number' ? h.similarity : null,
    }));
  } catch (e) {
    throw new LabError('SOURCE_UNAVAILABLE', `retrieval unavailable while freezing ${String(row.uid ?? '')}: ${(e as Error).message}`);
  }
}

export interface FrozenCase {
  case_key: string;
  member_key: string | null;
  frozen: OpdFrozen;
  source_versions: Record<string, unknown>;
}

/** Cohort mode asks for the two Slice B additions; single-case mode asks for neither. */
export interface FreezeOptions { withSources?: boolean; withMemberKey?: boolean }

/**
 * Freeze one OPD note and the three inputs the engine would otherwise read live.
 *
 * @throws LabError CASE_NOT_FOUND     — db13 answered, and there is no such note.
 * @throws LabError SOURCE_UNAVAILABLE — a source could not be reached or read.
 */
export async function freezeOpdCase(caseKey: string, opts: FreezeOptions = {}): Promise<FrozenCase> {
  // ── 1. the note (db13, via the existing Metabase reader) ───────────────────────────
  let row: Record<string, unknown> | null;
  try {
    row = await fetchOpdNoteByUid(caseKey);
  } catch (e) {
    // Unreachable is NOT the same as absent: reporting "no such note" for a Metabase
    // outage would let a caller freeze an empty dataset and believe the note is gone.
    throw new LabError('SOURCE_UNAVAILABLE', `db13 unavailable while reading note ${caseKey}: ${(e as Error).message}`);
  }
  if (!row) throw new LabError('CASE_NOT_FOUND', `no OPD note with uid ${caseKey}`);

  const { keys } = rowToOpdCase(row);

  // ── 2. the doctor's specialty (production Neon `doctor_directory`) ─────────────────
  // A null specialty is a LEGITIMATE frozen value — most doctors in the directory have
  // none — so the engine's own fail-safe (null on any error) is the right semantic here
  // and is inherited rather than second-guessed.
  let specialty: string | null = null;
  try {
    specialty = await doctorSpecialtyFor(keys.doctorUid);
  } catch (e) {
    throw new LabError('SOURCE_UNAVAILABLE', `doctor_directory unavailable: ${(e as Error).message}`);
  }

  // ── 3. the LVC rule snapshot (production Neon `lvc_recommendations`) ───────────────
  let lvcRules: OpdFrozen['lvc_rules'];
  try {
    const rules = await getLvcRules();
    lvcRules = rules.map((r) => {
      const keywords = (r.keywords ?? []).map((k) => String(k));
      const category = r.category ?? null;
      // The per-rule hash is over the rule's MEANING (id + keywords + category), so
      // dataset_validate can report a rule that was EDITED IN PLACE, not merely one that
      // was added or removed.
      return { id: r.id, hash: hash({ id: r.id, keywords, category }), keywords, category };
    });
  } catch (e) {
    throw new LabError('SOURCE_UNAVAILABLE', `lvc_recommendations unavailable: ${(e as Error).message}`);
  }
  // getLvcRules' own fail-safe returns [] on a timeout or an error, which is right for the
  // audit (never block a note) and WRONG for a freeze: an empty snapshot recorded as fact
  // would silently produce a research result scored against no rules at all. Production
  // never has zero active rules, so an empty read here is treated as unavailability.
  if (lvcRules.length === 0) {
    throw new LabError('SOURCE_UNAVAILABLE', 'lvc_recommendations returned no active rules — refusing to freeze an empty rule snapshot');
  }

  // ── 4. case-mix complexity (db13, via the existing bundle reader) ──────────────────
  // The engine's own complexityFor() swallows every error into a null band. Here that
  // would be wrong: a null band frozen because db13 blinked is a DIFFERENT input from a
  // null band because the patient has no history, and the two must not be confusable in
  // a dataset that claims to be reproducible.
  let complexity: OpdFrozen['complexity'];
  try {
    const inputs = await fetchPatientHistoryBundle(caseKey, keys.noteDate ? String(keys.noteDate) : undefined);
    complexity = inputs
      ? { band: bandFor(inputs), inputs: inputs as unknown as Record<string, unknown> }
      : { band: null, inputs: null };
  } catch (e) {
    throw new LabError('SOURCE_UNAVAILABLE', `db13 patient-history bundle unavailable for ${caseKey}: ${(e as Error).message}`);
  }

  // ── 5. the active suppressions and the quieting config (production Neon) ──────────
  // Decision 18: an error here is SOURCE_UNAVAILABLE, NEVER a frozen default. The engine's
  // own getActiveSuppressions/getQuietingConfig swallow errors into [] and gen 0, which is
  // right for an audit that must never be blocked and wrong for a freeze — a dataset that
  // recorded "no suppressions" because the table blinked would produce a research result
  // scored against rules production was actually applying. So the RAW loaders are called
  // here (they propagate), not the engine's fail-safe wrappers.
  let suppressions: OpdFrozen['suppressions'];
  let quietingConfig: OpdFrozen['quieting_config'];
  try {
    suppressions = (await loadActiveSuppressions()) as unknown as OpdFrozen['suppressions'];
  } catch (e) {
    throw new LabError('SOURCE_UNAVAILABLE', `audit_suppression unavailable: ${(e as Error).message}`);
  }
  try {
    quietingConfig = (await loadQuietingConfig()) as unknown as OpdFrozen['quieting_config'];
  } catch (e) {
    throw new LabError('SOURCE_UNAVAILABLE', `quieting config unavailable: ${(e as Error).message}`);
  }
  // Unlike the LVC rule set, an EMPTY suppressions list is a legitimate production state
  // (nothing has been suppressed yet), and gen 0 is a legitimate quieting generation. Only
  // an error is unavailability here, which is why neither gets the emptiness check above.

  // ── 6. Slice B additions, only when cohort mode asks (decisions 41 and 44) ─────────
  const sources = opts.withSources ? await freezeSources(row) : null;
  const memberKey = opts.withMemberKey ? await memberKeyForNote(caseKey) : null;

  return {
    case_key: caseKey,
    // Slice A froze no member key: a single-case dataset has one member and nothing to group by.
    // Cohort mode asks for it, and gets a salted hash — never an identifier (decision 44).
    member_key: memberKey,
    frozen: {
      note: row, specialty, complexity, lvc_rules: lvcRules, suppressions,
      quieting_config: quietingConfig,
      ...(sources ? { sources } : {}),
    },
    source_versions: {
      db13: 'metabase:individuals-prescriptions',
      lvc_rules_count: lvcRules.length,
      lvc_rules_hash: hash(lvcRules.map((r) => r.hash).sort()),
      suppressions_count: suppressions.length,
      quieting_gen: quietingConfig.gen,
      ...(sources ? { frozen_sources: sources.length, retrieval: 'candidate_stage_only' } : {}),
      frozen_at: new Date().toISOString(),
    },
  };
}

/**
 * §8.1 `dataset_validate` — re-read the case now and report whether each frozen input
 * still matches. Never throws for a mismatch; a mismatch is the ANSWER, not an error.
 */
export async function validateFrozenCase(caseKey: string, frozen: OpdFrozen): Promise<{ field: string; matches: boolean }[]> {
  const checks: { field: string; matches: boolean }[] = [];
  let current: FrozenCase | null = null;
  try {
    current = await freezeOpdCase(caseKey);
  } catch {
    return [{ field: 'source', matches: false }];
  }
  checks.push({ field: 'note', matches: hash(current.frozen.note) === hash(frozen.note) });
  checks.push({ field: 'specialty', matches: current.frozen.specialty === frozen.specialty });
  checks.push({ field: 'complexity', matches: hash(current.frozen.complexity) === hash(frozen.complexity) });
  checks.push({
    field: 'lvc_rules',
    matches: hash(current.frozen.lvc_rules.map((r) => r.hash).sort()) === hash(frozen.lvc_rules.map((r) => r.hash).sort()),
  });
  checks.push({ field: 'suppressions', matches: hash(current.frozen.suppressions) === hash(frozen.suppressions) });
  checks.push({ field: 'quieting_config', matches: hash(current.frozen.quieting_config) === hash(frozen.quieting_config) });
  return checks;
}
