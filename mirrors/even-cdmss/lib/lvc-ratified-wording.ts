/**
 * lib/lvc-ratified-wording.ts — Unit B of the LVC JUDGE PINNING PRD v1.0 (§3, D-5), 10 Aug 2026.
 *
 * THE RATIFIED RECOMMENDATION WORDING, AND THE IDEMPOTENT MIGRATION THAT APPLIES IT.
 *
 * WHAT THIS IS. Seven `lvc_recommendations.precondition` texts replaced verbatim with V's
 * ratified wording, and two records retired (`status = 'retired'`). Every touched row is stamped
 * `ratified_by` / `ratified_at`. The texts below were GENERATED from the PRD's §3 blockquotes —
 * not transcribed — so they are byte-exact with the ratified document; `lvc-ratified-wording.test.ts`
 * re-reads the PRD and asserts that byte-for-byte on every test run, so an edit here that drifts
 * from the ratified text fails the build rather than reaching a clinician.
 *
 * WHY THE WORDING CHANGES AT ALL. The A/A measurement (CDMSS-LVC-JUDGE-AA-REPORT-9-AUG-2026)
 * found the judge disagreeing with itself on 9 of 47 cases, and the flip-prone recommendations
 * were the ones whose preconditions did not say what to do about a fact the note simply does not
 * mention. Every ratified text now encodes ONE drafting convention explicitly: trigger facts must
 * be documented or the rec does not apply; exclusion facts NOT written in the note count as
 * ABSENT, and the verdict is then definite — never "insufficient information".
 *
 * ACCEPTED CONSEQUENCES, STATED (PRD §3): the B12 and vitamin-D rules will fire MORE often, and
 * the two retirements remove two finding sources entirely. These are ratified clinical outcomes,
 * not side effects.
 *
 * ⚠️ EVERY SQL STRING HERE IS INFERRED — written against migrations/0005 (the table) and
 * 0024 (ratified_by / ratified_at), with no live DB in the builder's sandbox. They are reproduced
 * verbatim in the build report for orchestrator validation BEFORE the migration is run.
 *
 * FAIL-SAFE AND IDEMPOTENT, by construction:
 *   · a READBACK runs FIRST — a schema/connectivity fault therefore aborts before any write;
 *   · every UPDATE carries an IS DISTINCT FROM guard, so a row already carrying the ratified
 *     value is not rewritten and the second run reports `changed: 0`;
 *   · statements are independent and each is individually idempotent, so an error part-way
 *     leaves a consistent table and a re-run completes the job.
 * There is NO transaction: lib/db speaks the Neon HTTP protocol, one statement per round trip,
 * and inventing a transaction primitive for this migration is out of scope. The guard above is
 * what makes that safe — flagged in the build report rather than papered over.
 */

/** Every touched row records WHO ratified the wording and WHEN (PRD §3). */
export const RATIFIED_BY = 'V (Dr Vinay Bhardwaj)';
/**
 * PRD §3 says `ratified_at = '2026-08-10'`. `ratified_at` is TIMESTAMPTZ (migrations/0024), so a
 * bare date literal would be resolved against the session time zone — the same migration could
 * then store a different instant on a different connection and the IS DISTINCT FROM guard would
 * rewrite the row, breaking idempotence. The instant is therefore pinned explicitly to midnight
 * UTC on the ratified date, which is what a UTC database (Neon's default) stores for '2026-08-10'.
 */
export const RATIFIED_AT = '2026-08-10T00:00:00Z';
/** PRD §3.3 / §3.4. NB: migrations/0005 documents the status vocabulary as active | superseded |
 *  withdrawn; 'retired' is the value the PRD ratifies and there is no CHECK constraint. Flagged,
 *  not decided — every reader filters `status = 'active'`, so a retired row simply stops being
 *  recalled, which is the intended effect. */
export const RETIRED_STATUS = 'retired';

export interface RatifiedPrecondition {
  /** the PRD section this text is copied from */
  section: string;
  /** lvc_recommendations.id */
  id: string;
  /** VERBATIM from PRD §3 — never edited here */
  precondition: string;
}

export interface RatifiedRetirement {
  section: string;
  id: string;
  reason: string;
}

export const RATIFIED_PRECONDITIONS: RatifiedPrecondition[] = [
  { section: '3.1', id: "ehrc-f283f2c4-7739-46e2-b5c8-997d89a79f5c", precondition: "Applies when the note documents (a) an acute upper-respiratory illness of 10 days or less — cough, sore throat, nasal block, coryza, or a diagnosis of URI / common cold / viral fever / acute pharyngitis / acute bronchitis — AND (b) a systemic antibiotic is prescribed. The recommendation applies unless the note documents a specific bacterial feature: radiographic or examination-confirmed pneumonia, streptococcal pharyngitis confirmed by RADT or culture, acute bacterial sinusitis (symptoms ≥10 days without improvement, or double-worsening), acute otitis media, or immunosuppression. If none of those bacterial features is written in the note, treat them as absent and conclude the recommendation APPLIES — do not answer \"insufficient information\" because the note is thin. Does not apply if no systemic antibiotic was prescribed, if the illness is documented as lasting more than 10 days, or if any bacterial feature above is documented." },
  { section: '3.2', id: "ehrc-f8b0572d-b082-48ec-9774-b7b8970aeb1c", precondition: "Applies when the note documents a treatment plan, a prescription, or a transfer/hand-off of care, AND the note contains neither (a) safety-netting advice — any statement of warning signs, red-flag symptoms, or circumstances that should prompt the patient to return or seek urgent care — nor (b) a follow-up instruction — any review date, review interval, referral for review, or \"return if not improving\" — nor (c) any instruction on how the response to a prescribed treatment is to be monitored. Any such instruction, however brief, means the recommendation does not apply. This is a deliberate inverted trigger: the absent documentation IS the finding, so an empty advice/follow-up field must be read as genuinely missing, not as unknown. If the note documents no treatment, no prescription and no hand-off, the recommendation does not apply." },
  { section: '3.5', id: "cwus-acr-002", precondition: "Applies when the note orders MRI or CT of the spine — any region, including whole-spine or multi-region \"screening\" studies — for pain being evaluated for a possible spinal cause. The recommendation applies unless the note documents at least one of: focal or progressive neurological deficit, radiculopathy, neurogenic claudication, saddle anaesthesia, bowel or bladder dysfunction, major trauma, cancer history, unexplained weight loss, fever or suspected spinal infection, IV drug use, immunosuppression, or a specific spinal procedure already planned for which the scan is required. A red flag that is not written in the note is absent for this purpose: conclude the recommendation APPLIES rather than \"insufficient information\". Prior workup for non-spinal causes is not required for this recommendation to apply. Does not apply when no spinal MRI or CT is ordered, or when any listed red flag is documented." },
  { section: '3.6', id: "cwus-acr-003", precondition: "Applies when the note orders a knee MRI for a knee injury the note describes as recent or acute (presenting within days of the injury), and no knee radiograph is documented as already performed. The recommendation applies unless the note documents at least one of: joint effusion or haemarthrosis, inability to bear weight, a positive ligamentous or meniscal test (Lachman, anterior drawer, pivot shift, McMurray), a locked or blocked knee, bony tenderness meeting the Ottawa Knee Rule, or surgery already planned. Findings not written in the note are absent for this purpose — a note that records an acute knee injury and an MRI order but no such examination finding means the recommendation APPLIES, not \"insufficient information\". Does not apply when the knee problem is chronic, atraumatic, or long-standing; when the note does not describe a recent injury; when radiographs are already documented; or when any listed finding is present." },
  { section: '3.7', id: "cwus-acp-002", precondition: "Applies when the note orders a lumbar-spine or spine MRI for low back pain that the note describes as chronic, recurrent, or lasting more than about 6 weeks. The recommendation applies unless the note documents at least one of: radiculopathy or focal neurological deficit, cauda-equina features (saddle anaesthesia, bowel or bladder dysfunction), major trauma, cancer history, unexplained weight loss, fever or suspected spinal infection, IV drug use, immunosuppression, a spinal injection or surgery already planned, or a completed and failed trial of conservative care (physiotherapy, structured exercise, or an adequate analgesic trial). Any of these not written in the note is absent for this purpose — conclude the recommendation APPLIES. If the note does not describe the back pain as chronic, recurrent, or longer than about 6 weeks, the recommendation does not apply (undocumented duration is a definite \"does not apply\", not \"insufficient information\")." },
  { section: '3.8', id: "cwus-aace-003", precondition: "Applies when the note orders a 25-hydroxyvitamin D level in an adult. The recommendation applies unless the note documents at least one of: osteoporosis or osteopenia, fragility or low-trauma fracture, chronic kidney disease, malabsorption (coeliac disease, inflammatory bowel disease, chronic pancreatitis, bariatric or gastric surgery), abnormal calcium or phosphate, hyperparathyroidism, chronic liver disease, rickets or osteomalacia, long-term glucocorticoid, anticonvulsant or antiretroviral therapy, documented bone pain or proximal muscle weakness, or investigation of recurrent falls. Non-specific complaints alone — fatigue, tiredness, generalised body ache — do NOT count as an indication. An indication that is not written in the note is absent for this purpose: conclude the recommendation APPLIES rather than \"insufficient information\". Does not apply when no vitamin D test is ordered or when any listed indication is documented." },
  { section: '3.9', id: "cwus-aace-004", precondition: "Applies when the note orders a vitamin B12 level. The recommendation applies unless the note documents at least one of: unexplained anaemia or raised MCV / macrocytosis, peripheral neuropathy or paraesthesia, cognitive decline or memory complaint, glossitis, known or suspected pernicious anaemia, metformin therapy, long-term proton-pump-inhibitor or H2-blocker use, strict vegetarian or vegan diet, malabsorption (coeliac disease, inflammatory bowel disease), gastric or bariatric surgery, or alcohol dependence. A symptom or risk factor that is not written in the note is absent for this purpose: conclude the recommendation APPLIES rather than \"insufficient information\". Does not apply when no B12 test is ordered or when any listed symptom or risk factor is documented." },
];

export const RATIFIED_RETIREMENTS: RatifiedRetirement[] = [
  { section: '3.3', id: "ehrc-fe8f229b-d818-4e40-a360-367fa85bfb02", reason: "duplicate of 3.2 — superseded by the merged safety-netting record (D-5a)" },
  { section: '3.4', id: "ehrc-cdfcf3bc-b737-4058-91af-600b5ca414fd", reason: "undocumented-ICD-code rec: self-contradictory, and coding gaps are already handled as informational (D-5b)" },
];

/** The nine rows this migration touches, in a stable order. */
export const RATIFIED_IDS: string[] = [
  ...RATIFIED_PRECONDITIONS.map((p) => p.id),
  ...RATIFIED_RETIREMENTS.map((r) => r.id),
];

// ── INFERRED SQL 1 — read the nine rows BEFORE writing anything ───────────────────────────────
// Runs first precisely so that a missing column (0024 unapplied), a missing table or a dead
// connection aborts the migration with ZERO writes rather than part-way through.
export const WORDING_READBACK_SQL = `SELECT id, precondition, status, ratified_by, ratified_at
  FROM lvc_recommendations
 WHERE id = ANY($1)`;

// ── INFERRED SQL 2 — one guarded precondition update ──────────────────────────────────────────
// The IS DISTINCT FROM guard is what makes the migration idempotent: a row already carrying the
// ratified text, ratifier and instant matches nothing and RETURNING yields no id.
export const PRECONDITION_UPDATE_SQL = `UPDATE lvc_recommendations
   SET precondition = $2,
       ratified_by  = $3,
       ratified_at  = $4::timestamptz,
       updated_at   = now()
 WHERE id = $1
   AND (precondition IS DISTINCT FROM $2
     OR ratified_by  IS DISTINCT FROM $3
     OR ratified_at  IS DISTINCT FROM $4::timestamptz)
 RETURNING id`;

// ── INFERRED SQL 3 — one guarded retirement ───────────────────────────────────────────────────
// Retirement does NOT touch precondition: the retired rows keep their text for the record, and
// `status = 'retired'` is what removes them from recall (defaultRecall selects status='active').
export const RETIREMENT_UPDATE_SQL = `UPDATE lvc_recommendations
   SET status      = $2,
       ratified_by = $3,
       ratified_at = $4::timestamptz,
       updated_at  = now()
 WHERE id = $1
   AND (status      IS DISTINCT FROM $2
     OR ratified_by IS DISTINCT FROM $3
     OR ratified_at IS DISTINCT FROM $4::timestamptz)
 RETURNING id`;

/** The one DB primitive this module needs. Injected, so the migration is unit-testable. */
export type SqlRunner = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

export type RowAction = 'precondition' | 'retire';
export type RowResult = 'updated' | 'unchanged' | 'missing' | 'error';

export interface WordingRowReport {
  section: string;
  id: string;
  action: RowAction;
  result: RowResult;
  /** post-write readback: does the row now hold exactly the ratified value? */
  verified?: boolean;
  detail?: string;
}

export interface WordingMigrationResult {
  ok: boolean;
  dryRun: boolean;
  ratifiedBy: string;
  ratifiedAt: string;
  /** rows this run actually changed — 0 on every run after the first (the idempotence claim) */
  changed: number;
  unchanged: number;
  missing: number;
  /** every one of the nine rows read back and confirmed to hold the ratified value */
  verified: boolean;
  rows: WordingRowReport[];
  error?: string;
}

interface CurrentRow {
  precondition: string | null;
  status: string | null;
  ratifiedBy: string | null;
  ratifiedAt: string | null;
}

function readRows(rows: Record<string, unknown>[]): Map<string, CurrentRow> {
  const m = new Map<string, CurrentRow>();
  for (const r of rows ?? []) {
    const id = String(r.id ?? '');
    if (!id) continue;
    m.set(id, {
      precondition: r.precondition == null ? null : String(r.precondition),
      status: r.status == null ? null : String(r.status),
      ratifiedBy: r.ratified_by == null ? null : String(r.ratified_by),
      ratifiedAt: r.ratified_at == null ? null : String(r.ratified_at),
    });
  }
  return m;
}

/**
 * Apply the ratified wording (PRD §3). Idempotent: the second run changes zero rows.
 *
 * `dryRun` reads and plans without writing — the orchestrator's pre-flight, and the only way to
 * see what the live table currently holds before touching it.
 */
export async function applyRatifiedWording(run: SqlRunner, opts: { dryRun?: boolean } = {}): Promise<WordingMigrationResult> {
  const dryRun = opts.dryRun === true;
  const base: WordingMigrationResult = {
    ok: true, dryRun, ratifiedBy: RATIFIED_BY, ratifiedAt: RATIFIED_AT,
    changed: 0, unchanged: 0, missing: 0, verified: false, rows: [],
  };

  // 1) READ FIRST. Any fault here aborts with zero writes — the fail-safe property.
  let before: Map<string, CurrentRow>;
  try {
    before = readRows(await run(WORDING_READBACK_SQL, [RATIFIED_IDS]));
  } catch (e) {
    return { ...base, ok: false, error: `readback failed, nothing written: ${String((e as Error).message).slice(0, 300)}` };
  }

  const rows: WordingRowReport[] = [];

  // 2) The guarded writes, one statement each, in a stable order.
  for (const p of RATIFIED_PRECONDITIONS) {
    const cur = before.get(p.id);
    if (!cur) { rows.push({ section: p.section, id: p.id, action: 'precondition', result: 'missing' }); continue; }
    const wouldChange = cur.precondition !== p.precondition || cur.ratifiedBy !== RATIFIED_BY || !sameInstant(cur.ratifiedAt, RATIFIED_AT);
    if (dryRun) { rows.push({ section: p.section, id: p.id, action: 'precondition', result: wouldChange ? 'updated' : 'unchanged' }); continue; }
    try {
      const r = await run(PRECONDITION_UPDATE_SQL, [p.id, p.precondition, RATIFIED_BY, RATIFIED_AT]);
      rows.push({ section: p.section, id: p.id, action: 'precondition', result: r.length ? 'updated' : 'unchanged' });
    } catch (e) {
      rows.push({ section: p.section, id: p.id, action: 'precondition', result: 'error', detail: String((e as Error).message).slice(0, 200) });
    }
  }

  for (const t of RATIFIED_RETIREMENTS) {
    const cur = before.get(t.id);
    if (!cur) { rows.push({ section: t.section, id: t.id, action: 'retire', result: 'missing' }); continue; }
    const wouldChange = cur.status !== RETIRED_STATUS || cur.ratifiedBy !== RATIFIED_BY || !sameInstant(cur.ratifiedAt, RATIFIED_AT);
    if (dryRun) { rows.push({ section: t.section, id: t.id, action: 'retire', result: wouldChange ? 'updated' : 'unchanged' }); continue; }
    try {
      const r = await run(RETIREMENT_UPDATE_SQL, [t.id, RETIRED_STATUS, RATIFIED_BY, RATIFIED_AT]);
      rows.push({ section: t.section, id: t.id, action: 'retire', result: r.length ? 'updated' : 'unchanged' });
    } catch (e) {
      rows.push({ section: t.section, id: t.id, action: 'retire', result: 'error', detail: String((e as Error).message).slice(0, 200) });
    }
  }

  // 3) READ BACK. PRD §5.1 asks the orchestrator to confirm the nine rows read back exactly; this
  //    does it in the same call rather than leaving it to a hand-run query.
  let verifiedAll = false;
  if (!dryRun) {
    try {
      const after = readRows(await run(WORDING_READBACK_SQL, [RATIFIED_IDS]));
      for (const row of rows) {
        const cur = after.get(row.id);
        if (!cur) { row.verified = false; continue; }
        const spec = RATIFIED_PRECONDITIONS.find((p) => p.id === row.id);
        row.verified = (row.action === 'precondition'
          ? cur.precondition === (spec ? spec.precondition : null)
          : cur.status === RETIRED_STATUS)
          && cur.ratifiedBy === RATIFIED_BY && sameInstant(cur.ratifiedAt, RATIFIED_AT);
      }
      verifiedAll = rows.length === RATIFIED_IDS.length && rows.every((r) => r.verified === true);
    } catch (e) {
      return {
        ...base, ok: false, rows,
        changed: rows.filter((r) => r.result === 'updated').length,
        unchanged: rows.filter((r) => r.result === 'unchanged').length,
        missing: rows.filter((r) => r.result === 'missing').length,
        error: `writes ran but the verification readback failed: ${String((e as Error).message).slice(0, 300)}`,
      };
    }
  }

  const errored = rows.filter((r) => r.result === 'error');
  return {
    ...base,
    ok: errored.length === 0 && rows.every((r) => r.result !== 'missing'),
    changed: rows.filter((r) => r.result === 'updated').length,
    unchanged: rows.filter((r) => r.result === 'unchanged').length,
    missing: rows.filter((r) => r.result === 'missing').length,
    verified: dryRun ? false : verifiedAll,
    rows,
    ...(errored.length ? { error: `${errored.length} row(s) failed to update; every statement is independently idempotent, so re-running completes the job` } : {}),
  };
}

/**
 * Is a stored timestamp the ratified instant? The DB returns TIMESTAMPTZ in its own textual form
 * ('2026-08-10 00:00:00+00'), which never string-equals the ISO literal we send, so a naive
 * comparison would report every row unverified forever. Compared as instants, with a null-safe
 * fallback to string equality when either side is unparseable.
 */
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  const ta = Date.parse(a), tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return String(a) === String(b);
  return ta === tb;
}
