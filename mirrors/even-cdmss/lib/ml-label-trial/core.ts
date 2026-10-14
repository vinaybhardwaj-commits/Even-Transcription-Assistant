/**
 * lib/ml-label-trial/core.ts — ML Phase 1 retrospective validation, PURE core.
 * (PRD CDMSS-ML-PHASE1-VALIDATION 28 Jul 2026; ruling CDMSS-MACHINE-LABELLING-RULING.)
 *
 * THIS BUILD ONLY MEASURES. Nothing here writes anywhere; the route stores its artefact in the
 * LAB store (lab_analyses) and the human label stream (opd_audit_feedback) is never written —
 * the moment the streams mix, the ground truth is gone and cannot be recovered (ruling §2b).
 *
 * ═══ D1 — BLINDNESS IS STRUCTURAL ═══
 * `renderLabelPrompt` takes the FINDING (what the engine asserted) and the NOTE CONTEXT (what the
 * finding was raised against) — its input type has no field for the human label, the reviewer
 * name, the human comment, or any triage value, so a leak requires widening a signature that a
 * test pins at arity 2. No persona (ruling §2a): a closed rubric, the reviewer surface's own
 * class definitions, and nothing that role-plays a person. Calibrate, don't cosplay.
 */

export const TRIAL_PROMPT_VERSION = 'ml-label-trial/1.0';

/** D3 — the model's three classes. `contested` is reserved for the clinician whose care was
 *  audited, permanently; it is not an option the model is given and never appears in its prompt. */
export const LABEL_CLASSES = ['tp', 'nitpick', 'false'] as const;
export type LabelClass = (typeof LABEL_CLASSES)[number];

/** D9 — hard call cap, checked BEFORE the first call. Expected plan: 778×2 + 39×2 = 1,634.
 *  Headroom over the expected figure exists only because the human set grows daily; the cap is a
 *  runaway backstop, not a target. */
export const MAX_TRIAL_CALLS = 2000;

/** What the model sees (D2): the finding as the reviewer surface presents it. These six fields are
 *  the ENGINE's assertion — `verdict` here is the engine's low-value/context-dependent verdict,
 *  not anyone's triage. */
export interface TrialFinding {
  subject: string;
  verdict: string;
  domain: string;
  signal_type?: string | null;
  rationale: string;
  confidence: number;
}

/**
 * Render the blind prompt. The rubric definitions are VERBATIM from the reviewer surface
 * (finding-triage.tsx), so the model is scored against the same taxonomy the humans use.
 */
export function renderLabelPrompt(finding: TrialFinding, noteContext: string | null): { system: string; user: string } {
  const system = `You are auditing the output of a clinical documentation engine. You will be shown ONE finding the engine raised against an outpatient note, plus the note's content. Classify the finding into exactly one class:

- "tp" — Correct and worth surfacing.
- "nitpick" — Technically correct but low-value noise.
- "false" — Wrong / not supported by the note.

Judge only whether the ENGINE's finding holds against the note shown. Reply with ONLY a JSON object, no other text:
{"label":"tp"|"nitpick"|"false","rationale":"<one or two sentences>"}`;

  const user = `## The engine's finding
- Subject: ${finding.subject}
- Engine verdict: ${finding.verdict}
- Domain: ${finding.domain}
- Signal type: ${finding.signal_type ?? '(none)'}
- Engine rationale: ${finding.rationale}
- Engine confidence: ${finding.confidence}

## The note it was raised against
${noteContext ?? '(note context unavailable)'}`;

  return { system, user };
}

/** §6.3 — three classes or `unparseable`. NEVER coerced to the nearest class, NEVER dropped:
 *  a dropped row inflates agreement. The raw text is retained for the artefact. */
export interface ParsedLabel { cls: LabelClass | 'unparseable'; rationale: string; raw: string }
export function parseLabelResponse(raw: string): ParsedLabel {
  const text = String(raw ?? '');
  // Accept exactly one JSON object, possibly fenced or surrounded by prose.
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]) as { label?: unknown; rationale?: unknown };
      const label = j.label;
      if (typeof label === 'string' && (LABEL_CLASSES as readonly string[]).includes(label)) {
        return { cls: label as LabelClass, rationale: typeof j.rationale === 'string' ? j.rationale.slice(0, 2000) : '', raw: text };
      }
    } catch { /* fall through to unparseable */ }
  }
  return { cls: 'unparseable', rationale: '', raw: text };
}

/** D9 — the plan, refused before the first call if over the cap. */
export function planTrial(scored: number, contested: number): { calls: number; ok: boolean; reason?: string } {
  const calls = (scored + contested) * 2;   // D6 — two full passes, including the contested rows (D5)
  if (calls > MAX_TRIAL_CALLS) {
    return { calls, ok: false, reason: `planned ${calls} calls exceeds the hard cap ${MAX_TRIAL_CALLS} — refuse before the first call (D9)` };
  }
  return { calls, ok: true };
}

// ─── in-flight correction (28 Jul): dedup, output-side reconciliation, cross-invocation ─────────

/** A stored result row as it sits in a chunk artefact, with its provenance. */
export interface StoredTrialRow {
  key: string;
  chunk: string;             // input_ref of the artefact that carried it
  storedAt: string;          // artefact created_at (ISO) — the dedup tie-break input
  row: Record<string, unknown>;
}

/**
 * C1 — DEDUP RULE (stated, deterministic): one row per distinct finding key, the row from the
 * LATEST artefact winning (`storedAt` DESC, then chunk string DESC as a total tie-break).
 * Latest-wins rather than earliest-wins because a re-run of a failed window (e.g. the bad-model
 * shakedown, whose 20 rows are all CALL_ERROR) must be superseded by the later valid answers —
 * earliest-wins would enshrine the failure. Duplicates are NOT discarded (C4): they are returned
 * separately as the overlap set, which is a measurement.
 */
export function dedupStoredRows(rows: StoredTrialRow[]): { winners: Map<string, StoredTrialRow>; overlap: Map<string, StoredTrialRow[]> } {
  const byKey = new Map<string, StoredTrialRow[]>();
  for (const r of rows) {
    const list = byKey.get(r.key) ?? [];
    list.push(r);
    byKey.set(r.key, list);
  }
  const winners = new Map<string, StoredTrialRow>();
  const overlap = new Map<string, StoredTrialRow[]>();
  for (const [key, list] of byKey) {
    const sorted = list.slice().sort((a, b) => (b.storedAt.localeCompare(a.storedAt)) || (b.chunk.localeCompare(a.chunk)));
    winners.set(key, sorted[0]);
    if (list.length > 1) overlap.set(key, sorted);
  }
  return { winners, overlap };
}

/**
 * §4 — CROSS-INVOCATION agreement: the same model answering the same finding in separate process
 * invocations. Reported as its OWN figure, clearly separated from within-invocation self-agreement
 * (pass1 vs pass2 inside one invocation) — they answer different questions and are never pooled.
 * Only rows with a RESOLVED label_source count (a CALL_ERROR row is not an invocation's answer).
 */
export function crossInvocationAgreement(overlap: Map<string, StoredTrialRow[]>): {
  keysWithMultipleInvocations: number;
  pass1Agree: number; pass2Agree: number;
  allFourIdentical: number;
  comparisons: number;
} {
  let p1 = 0, p2 = 0, all4 = 0, n = 0;
  for (const list of overlap.values()) {
    const valid = list.filter((r) => {
      const s1 = r.row.pass1_source, s2 = r.row.pass2_source;
      return typeof s1 === 'string' && s1 !== 'unresolved' && typeof s2 === 'string' && s2 !== 'unresolved';
    });
    if (valid.length < 2) continue;
    n++;
    const [a, b] = valid;   // latest two valid invocations
    if (a.row.pass1 === b.row.pass1) p1++;
    if (a.row.pass2 === b.row.pass2) p2++;
    if (a.row.pass1 === b.row.pass1 && a.row.pass2 === b.row.pass2 && a.row.pass1 === a.row.pass2) all4++;
  }
  return { keysWithMultipleInvocations: n, pass1Agree: p1, pass2Agree: p2, allFourIdentical: all4, comparisons: n };
}

// ─── metrics ─────────────────────────────────────────────────────────────────────────────────────

/** Cohen's κ over labelled pairs. Multi-class; total: empty ⇒ 0; pe = 1 (perfect chance) guarded. */
export function cohenKappa(pairs: [string, string][]): number {
  const n = pairs.length;
  if (n === 0) return 0;
  const classes = Array.from(new Set(pairs.flat()));
  let agree = 0;
  const a: Record<string, number> = {}, b: Record<string, number> = {};
  for (const [x, y] of pairs) {
    if (x === y) agree++;
    a[x] = (a[x] || 0) + 1;
    b[y] = (b[y] || 0) + 1;
  }
  const po = agree / n;
  let pe = 0;
  for (const c of classes) pe += ((a[c] || 0) / n) * ((b[c] || 0) / n);
  if (pe >= 1) return po >= 1 ? 1 : 0;   // degenerate: all one class on both sides
  return (po - pe) / (1 - pe);
}

/** One finding's trial outcome. `human` is the CURRENT-STATE human verdict mapped to the model
 *  vocabulary ('true_positive' → 'tp' — the same class under its storage name, not a re-mapping);
 *  contested rows keep human='contested' and are held out of every rate (D5). */
export interface TrialRow {
  key: string;                       // audit_id:finding_ref
  human: string;                     // tp | nitpick | false | contested
  engine: string;                    // engine_version of the audited row (D10)
  signalType: string | null;
  pass1: string;                     // tp | nitpick | false | unparseable | missing
  pass2: string;
  contested: boolean;
}

interface Confusion { [human: string]: { [model: string]: number } }
interface PerClass { cls: string; precision: number; recall: number; n_human: number; n_model: number }
interface PassStats { agreementRate: number; kappa: number; confusion: Confusion }

function passStats(rows: TrialRow[], pick: (r: TrialRow) => string): PassStats {
  const pairs: [string, string][] = rows.map((r) => [r.human, pick(r)]);
  const confusion: Confusion = {};
  let agree = 0;
  for (const [h, m] of pairs) {
    confusion[h] = confusion[h] || {};
    confusion[h][m] = (confusion[h][m] || 0) + 1;
    if (h === m) agree++;
  }
  return { agreementRate: pairs.length ? agree / pairs.length : 0, kappa: cohenKappa(pairs), confusion };
}

function perClassStats(confusion: Confusion): PerClass[] {
  const out: PerClass[] = [];
  const models = new Set<string>();
  for (const h of Object.keys(confusion)) for (const m of Object.keys(confusion[h])) models.add(m);
  for (const cls of LABEL_CLASSES) {
    const nHuman = Object.values(confusion[cls] ?? {}).reduce((s, x) => s + x, 0);
    let nModel = 0, hit = 0;
    for (const h of Object.keys(confusion)) {
      nModel += confusion[h][cls] || 0;
      if (h === cls) hit = confusion[h][cls] || 0;
    }
    out.push({
      cls,
      precision: nModel ? hit / nModel : 0,
      recall: nHuman ? hit / nHuman : 0,
      n_human: nHuman, n_model: nModel,
    });
  }
  return out;
}

export interface TrialReport {
  reconciliation: { total: number; scored: number; contested: number; arithmetic: string };
  scored: {
    n: number;
    pass1: PassStats; pass2: PassStats;
    pooled: PassStats & { perClass: PerClass[] };
  };
  selfAgreement: { rate: number; kappa: number; n: number };
  byEngine: { engine: string; n: number; agreementRate: number; kappa: number }[];
  contestedSection: {
    n: number;
    modelDistribution: { pass1: Record<string, number>; pass2: Record<string, number> };
    selfAgreementRate: number;
  };
  unparseable: { total: number; pass1: number; pass2: number };
  killCondition: { selfAgreement: number; pooledHumanAgreement: number; selfAgreementClearlyAboveHuman: boolean; statement: string };
}

/** The whole §7 readout, PURE, from the collected rows. Contested rows are sent/answered/stored
 *  upstream and land here flagged; they are excluded from κ and every rate, and described in their
 *  own section (D5). Unparseable answers stay in the set as disagreements (§6.3). */
export function computeTrialReport(rows: TrialRow[]): TrialReport {
  const contested = rows.filter((r) => r.contested);
  const scored = rows.filter((r) => !r.contested);

  const p1 = passStats(scored, (r) => r.pass1);
  const p2 = passStats(scored, (r) => r.pass2);
  const pooledRows = [...scored.map((r) => ({ ...r, m: r.pass1 })), ...scored.map((r) => ({ ...r, m: r.pass2 }))];
  const pooled = passStats(pooledRows as unknown as TrialRow[], (r) => (r as unknown as { m: string }).m);

  const selfPairs: [string, string][] = scored.map((r) => [r.pass1, r.pass2]);
  const selfAgree = selfPairs.filter(([a, b]) => a === b).length;
  const selfRate = selfPairs.length ? selfAgree / selfPairs.length : 0;

  const byEngine: TrialReport['byEngine'] = [];
  for (const engine of Array.from(new Set(scored.map((r) => r.engine))).sort()) {
    const sub = scored.filter((r) => r.engine === engine);
    const st = passStats(
      [...sub.map((r) => ({ ...r, m: r.pass1 })), ...sub.map((r) => ({ ...r, m: r.pass2 }))] as unknown as TrialRow[],
      (r) => (r as unknown as { m: string }).m,
    );
    byEngine.push({ engine, n: sub.length, agreementRate: st.agreementRate, kappa: st.kappa });
  }

  const dist = (pick: (r: TrialRow) => string): Record<string, number> => {
    const d: Record<string, number> = {};
    for (const r of contested) { const v = pick(r); d[v] = (d[v] || 0) + 1; }
    return d;
  };

  const unparseable = {
    pass1: rows.filter((r) => r.pass1 === 'unparseable').length,
    pass2: rows.filter((r) => r.pass2 === 'unparseable').length,
    total: 0,
  };
  unparseable.total = unparseable.pass1 + unparseable.pass2;

  // §3 — the kill condition, computed and stated rather than left for a reader to notice.
  const clearly = selfRate > pooled.agreementRate;
  const statement = clearly
    ? `Self-agreement (${selfRate.toFixed(3)}) exceeds pooled human agreement (${pooled.agreementRate.toFixed(3)}) — the §3 kill condition does NOT hold.`
    : `KILL CONDITION HOLDS: self-agreement (${selfRate.toFixed(3)}) does not clearly exceed pooled human agreement (${pooled.agreementRate.toFixed(3)}). The labeller's disagreement with the humans is mostly the labeller arguing with itself, and the human-agreement number means nothing (PRD §3).`;

  return {
    reconciliation: {
      total: rows.length, scored: scored.length, contested: contested.length,
      arithmetic: `${scored.length} scored + ${contested.length} contested = ${scored.length + contested.length} (rows in trial: ${rows.length})`,
    },
    scored: { n: scored.length, pass1: p1, pass2: p2, pooled: { ...pooled, perClass: perClassStats(pooled.confusion) } },
    selfAgreement: { rate: selfRate, kappa: cohenKappa(selfPairs), n: selfPairs.length },
    byEngine,
    contestedSection: {
      n: contested.length,
      modelDistribution: { pass1: dist((r) => r.pass1), pass2: dist((r) => r.pass2) },
      selfAgreementRate: contested.length ? contested.filter((r) => r.pass1 === r.pass2).length / contested.length : 0,
    },
    unparseable,
    killCondition: {
      selfAgreement: selfRate, pooledHumanAgreement: pooled.agreementRate,
      selfAgreementClearlyAboveHuman: clearly, statement,
    },
  };
}

// ─── cohort freeze (addendum, 28 Jul): the Phase-1 validation set is a FROZEN key list ───────────

/** One frozen cohort entry: the key and the human label AS OF THE FREEZE. Metrics computed over a
 *  cohort use the FROZEN label, not the live current-state one — a post-freeze revision by the
 *  reviewer must not silently move a reproducible number (it is counted instead). */
export interface CohortEntry { key: string; human: string; signalType: string | null; engine: string }

/**
 * Intersect labelled winners with a frozen cohort:
 *   · cohortRows — winners ∩ cohort, human label OVERRIDDEN by the frozen one (revisions counted);
 *   · extraKeys — labelled but outside the cohort (kept, reported separately, never folded in);
 *   · missingKeys — cohort keys not yet labelled (the keyed top-up target);
 *   · revisedSinceFreeze — winners whose captured-at-chunk-time label differs from the frozen one.
 */
export function applyCohort(
  winners: Map<string, { row: Record<string, unknown> }>,
  cohort: CohortEntry[],
): { cohortRows: TrialRow[]; extraKeys: string[]; missingKeys: string[]; revisedSinceFreeze: number } {
  const byKey = new Map(cohort.map((e) => [e.key, e]));
  const cohortRows: TrialRow[] = [];
  const extraKeys: string[] = [];
  let revised = 0;
  for (const [key, w] of winners) {
    const e = byKey.get(key);
    if (!e) { extraKeys.push(key); continue; }
    if (w.row.status === 'finding_unmatched') continue;
    const frozenHuman = e.human === 'true_positive' ? 'tp' : e.human;
    if (String(w.row.human) !== frozenHuman) revised++;
    cohortRows.push({
      key, human: frozenHuman, engine: e.engine, signalType: e.signalType,
      pass1: String(w.row.pass1 ?? 'missing'), pass2: String(w.row.pass2 ?? 'missing'),
      contested: frozenHuman === 'contested',
    });
  }
  const labelled = new Set(winners.keys());
  const missingKeys = cohort.map((e) => e.key).filter((k) => !labelled.has(k)).sort();
  return { cohortRows, extraKeys: extraKeys.sort(), missingKeys, revisedSinceFreeze: revised };
}
