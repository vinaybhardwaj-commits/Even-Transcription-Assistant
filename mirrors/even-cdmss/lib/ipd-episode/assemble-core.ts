/**
 * lib/ipd-episode/assemble-core.ts — the PURE half of episode assembly (PRD §3.2):
 * the event schema, the day index, ordering, the order-event roll-ups, the note summary,
 * author normalisation, and the blinding filters that build every checkpoint and pass input.
 *
 * NO db, NO model, NO Next. Everything here is a function of rows already fetched.
 *
 * TWO RULES THIS FILE EXISTS TO MAKE STRUCTURAL, both of which a source-read test enforces:
 *
 * 1. IDS ARE NEVER REWRITTEN. `IPNO-1` and `IP-1` are different patients — measured on 585 of
 *    585 rewritten joins, none of which shared a uhid (DB addendum A2). So no trimming, no
 *    prefix substitution, no normalising: an id that arrives is the id that joins and the id
 *    that is stored.
 * 2. CLINICAL TIME IS NEVER THE MIRROR'S TIME. `_create_time` is when the Firestore mirror wrote
 *    the row (every progress note shows the same ingest day), and `created_at` agrees with the
 *    clinician-stated time on 20% of rows and is null on 148. The clinical timestamp is
 *    `progressnote_date_time` out of the component_json {name, valueString} array, then
 *    `g_creation_time`. An event whose clinical time cannot be resolved is Tier C and is
 *    excluded from every checkpoint input rather than guessed onto a day.
 *
 * AND ONE ARCHITECTURAL RULE, which is the blinding proof: every checkpoint input and every
 * pass input is produced by FILTERING the single assembled event list (`eventsBeforeDayStart`,
 * `episodeLevelEvents`, `diffPassEvents`, `fidelityPassEvents`). There is no second assembly
 * path, so no input can drift into carrying something the blinding rule excludes.
 */

// ── the event ────────────────────────────────────────────────────────────────────────────────

export type EpisodeEventType =
  | 'admission' | 'initial_assessment' | 'note' | 'order' | 'lab_order'
  | 'handover' | 'ot_note' | 'transfer' | 'discharge';

export type EvidenceTier = 'A' | 'B' | 'C';

export interface EventProvenance {
  source_table: string;
  source_record_id: string;
  source_timestamp: string | null;
}

export interface EpisodeEvent {
  event_id: string;
  /** ISO 8601 UTC. NULL when no clinical timestamp resolved — Tier C, excluded from checkpoints. */
  occurred_at: string | null;
  day_index: number;
  event_type: EpisodeEventType;
  summary: string;
  detail: Record<string, unknown>;
  author_name: string | null;
  author_role: string | null;
  responsible_clinician_id: string | null;
  provenance: EventProvenance;
  evidence_tier: EvidenceTier;
}

/** Tier per source table (PRD §4.1). Anything unlisted is Tier C — the honest default. */
export const TIER_A_TABLES = [
  'kx_ip_admissions',
  'kx_clinical_template_progress_reports',
  'kx_billing_records',
  'kx_lab_reports',
  'kx_discharge_summary_records',
  'discharge_extracted_cases',
] as const;

export const TIER_B_TABLES = [
  'kx_clinical_template_initial_assessment_adults',
  'kx_clinical_template_shift_handovers',
  'kx_clinical_template_ot_notes',
  'kx_ip_transfers',
] as const;

/**
 * ROUND 20 ITEM 1 / DECISION 41 — WHICH `discharge_type` VALUES MEAN THE PATIENT DIED.
 *
 * ⚠️ DERIVED FROM THE DATA, NOT RECALLED. Queried on 2026-09-04 against db13
 * `kx_discharge_summary_records`, all 2,496 rows, 14 distinct values:
 *
 *     Normal Discharge 2236 · None 155 · LAMA 33 · DAMA 28 · Discharge On Request 18 ·
 *     Expired 8 · Admitted Dead 3 · Refer External Hospital 3 · (empty) 3 · Mortuary 3 ·
 *     Referral 2 · mortuary 2 · Early Neonatal 1 · Absconded 1
 *
 * THREE MEAN DEATH: `Expired`, `Admitted Dead`, `Mortuary` — 16 records between them. The match is
 * CASE-INSENSITIVE because the mirror carries both `Mortuary` (3) and `mortuary` (2); a
 * case-sensitive list would have exempted three episodes and audited two of the same kind normally.
 *
 * ⚠️ `Early Neonatal` IS DELIBERATELY NOT MATCHED. It may well be a neonatal death category, but it
 * may equally be a discharge category, and one row cannot settle it. An unrecognised value AUDITS
 * NORMALLY — which is the direction this must fail in. Exempting an episode from the terminal-day
 * rule on a guess would silently stop auditing a real admission; auditing a death as if it were a
 * discharge produces findings a human will notice and can correct. The loud failure is the safer
 * one, and it is the one a wrong guess here produces.
 *
 * EXACT match on the trimmed, lower-cased value, never a substring: `Refer External Hospital`
 * contains no death word today, but a substring rule is a standing invitation for one to appear.
 */
export const DEATH_DISCHARGE_TYPES: readonly string[] = ['expired', 'admitted dead', 'mortuary'];

export function dischargeIndicatesDeath(dischargeType: string | null | undefined): boolean {
  const t = String(dischargeType ?? '').trim().toLowerCase();
  if (!t) return false;
  return DEATH_DISCHARGE_TYPES.includes(t);
}

export function tierForTable(table: string | null | undefined): EvidenceTier {
  const t = String(table ?? '');
  if ((TIER_A_TABLES as readonly string[]).includes(t)) return 'A';
  if ((TIER_B_TABLES as readonly string[]).includes(t)) return 'B';
  return 'C';
}

/**
 * The nine completeness sources (PRD §6.2): the five Tier A sources — the discharge summary and
 * its stored extraction count as ONE — and the four Tier B sources.
 */
export const COMPLETENESS_SOURCES = [
  'kx_ip_admissions',
  'kx_clinical_template_progress_reports',
  'kx_billing_records',
  'kx_lab_reports',
  'kx_discharge_summary_records',
  'kx_clinical_template_initial_assessment_adults',
  'kx_clinical_template_shift_handovers',
  'kx_clinical_template_ot_notes',
  'kx_ip_transfers',
] as const;

// ── time ─────────────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 3600 * 1000;

/** Epoch ms → ISO 8601 UTC, or null. Accepts a number or a numeric string (epoch milliseconds). */
export function isoFromEpochMs(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A timestamp column value → ISO 8601 UTC, or null. Never throws on a malformed value. */
export function isoFromTimestamp(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString();
  if (typeof raw === 'number') return isoFromEpochMs(raw);
  const s = String(raw).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * `day_index` 0 starts at the admission timestamp; each boundary is exactly 24 hours after the
 * previous one (PRD §3.2.2). Deliberately NOT a calendar-date difference: an admission at 23:50
 * and an event at 00:10 the next morning are twenty minutes apart and belong to day 0.
 */
export function dayIndexFor(admissionIso: string, occurredIso: string | null): number {
  if (!occurredIso) return 0;
  const a = Date.parse(admissionIso);
  const o = Date.parse(occurredIso);
  if (!Number.isFinite(a) || !Number.isFinite(o)) return 0;
  return Math.max(0, Math.floor((o - a) / DAY_MS));
}

/** The instant day N begins: admission + N × 24h, as ISO 8601 UTC. */
export function dayStartIso(admissionIso: string, dayIndex: number): string {
  const a = Date.parse(admissionIso);
  if (!Number.isFinite(a)) return admissionIso;
  return new Date(a + dayIndex * DAY_MS).toISOString();
}

/** `los_days = floor(hours(admission → discharge) / 24)` (decision 26). Null when either is absent. */
export function losDaysFor(admissionIso: string | null, dischargeIso: string | null): number | null {
  if (!admissionIso || !dischargeIso) return null;
  const a = Date.parse(admissionIso);
  const d = Date.parse(dischargeIso);
  if (!Number.isFinite(a) || !Number.isFinite(d)) return null;
  return Math.max(0, Math.floor(((d - a) / 3600_000) / 24));
}

/**
 * Stable clinical ordering: by `occurred_at`, then by event id. Events with no clinical timestamp
 * sort last — they are Tier C and no checkpoint sees them, so their position is presentational.
 */
export function sortEvents(events: EpisodeEvent[]): EpisodeEvent[] {
  return [...events].sort((x, y) => {
    if (x.occurred_at && y.occurred_at) {
      if (x.occurred_at !== y.occurred_at) return x.occurred_at < y.occurred_at ? -1 : 1;
    } else if (x.occurred_at) return -1;
    else if (y.occurred_at) return 1;
    return x.event_id < y.event_id ? -1 : x.event_id > y.event_id ? 1 : 0;
  });
}

// ── the blinding filters (PRD §3.3.3, §3.4.1, §3.5) ──────────────────────────────────────────
// Every one of these takes the SINGLE assembled list and returns a subset of it. Nothing here
// builds an event, so nothing here can leak a field a filter is meant to withhold.

export const isAdmissionEvent = (e: EpisodeEvent) => e.event_type === 'admission';
export const isDischargeEvent = (e: EpisodeEvent) => e.event_type === 'discharge';

/**
 * The day-N checkpoint input: the admission event, plus every event whose `occurred_at` is
 * STRICTLY earlier than the start of day N. Nothing else — no discharge event, no event on or
 * after the boundary, and no event whose clinical time never resolved (§3.2.2).
 *
 * Day 0 therefore sees the admission event alone, which is the point: it is the expectation
 * formed at the door.
 */
export function eventsBeforeDayStart(events: EpisodeEvent[], admissionIso: string, dayIndex: number): EpisodeEvent[] {
  const cutoff = dayStartIso(admissionIso, dayIndex);
  return sortEvents(events).filter((e) => {
    if (isDischargeEvent(e)) return false;
    if (isAdmissionEvent(e)) return true;
    if (!e.occurred_at) return false;
    return e.occurred_at < cutoff;
  });
}

/**
 * The episode-level checkpoint input: every event EXCEPT the discharge event (decision 25),
 * less any event with no resolved clinical time, which §3.2.2 excludes from every checkpoint.
 */
export function episodeLevelEvents(events: EpisodeEvent[]): EpisodeEvent[] {
  return sortEvents(events).filter((e) => {
    if (isDischargeEvent(e)) return false;
    if (isAdmissionEvent(e)) return true;
    return e.occurred_at != null;
  });
}

/** Pass A1's input: every event except the discharge event (§3.4.1). Tier C events are kept —
 *  A1 reads the whole documented course; only CHECKPOINTS exclude untimestamped events. */
export function diffPassEvents(events: EpisodeEvent[]): EpisodeEvent[] {
  return sortEvents(events).filter((e) => !isDischargeEvent(e));
}

/** Pass A2's input: every event INCLUDING the discharge event (§3.5). */
export function fidelityPassEvents(events: EpisodeEvent[]): EpisodeEvent[] {
  return sortEvents(events);
}

// ── checkpoint budget (decision 24) ──────────────────────────────────────────────────────────

export const EPISODE_CHECKPOINT_ID = 'cp-episode';
export const MAX_DAILY_CHECKPOINT_DAY = 6;
/** DECISION 43: the hard ceiling on checkpoints per episode, anchors and episode-level together. */
export const MAX_CHECKPOINTS = 8;

/** What a checkpoint is anchored to. Recorded on the row so a reader knows why it exists. */
/**
 * DECISION 52 (V, 2026-09-05) — AFTER A PROCEDURE, EVERY DAY IS CHECKPOINTED UNTIL DISCHARGE.
 * `procedure_plus_2` and `procedure_plus_4` are RETIRED: sampling day 2 and day 4 was an arbitrary
 * grid laid over a post-operative course, and it left the days between them unexamined. The run is
 * `procedure_day_1`, `procedure_day_2`, … one per day, and it stops at the pre-discharge day.
 *
 * The list is finite because the plan is: at most MAX_CHECKPOINTS − 1 daily checkpoints exist, and
 * `first_24h` and `pre_discharge` take two of them, so a post-procedure run can never be longer
 * than five days before the cap bites.
 */
export const ANCHOR_KINDS = ['first_24h', 'procedure',
  'procedure_day_1', 'procedure_day_2', 'procedure_day_3', 'procedure_day_4', 'procedure_day_5',
  'pre_discharge', 'episode'] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

/** How many days a post-procedure run can cover before the cap must bite. */
export const MAX_PROCEDURE_RUN_DAYS = 5;

/** Is this anchor part of the procedure family — the procedure day or its daily run? */
export function isProcedureAnchor(k: AnchorKind): boolean {
  return k === 'procedure' || k.startsWith('procedure_day_');
}

/** Hours after admission at which the first-24h checkpoint cuts off. */
/** Which anchors survive a same-day collision and a full budget. The first window and the
 *  pre-discharge window rank above procedure follow-ups: they are the two moments an audit most
 *  wants a view of, and IPNO-495 lost pre_discharge to a follow-up before this existed. */
export const ANCHOR_PRIORITY: Record<AnchorKind, number> = {
  first_24h: 0, pre_discharge: 1, procedure: 2,
  procedure_day_1: 3, procedure_day_2: 4, procedure_day_3: 5, procedure_day_4: 6, procedure_day_5: 7,
  episode: 8,
};

export const FIRST_WINDOW_HOURS = 24;
/** Hours before discharge at which the pre-discharge checkpoint cuts off. */
export const PRE_DISCHARGE_HOURS = 24;

const HOUR_MS = 3_600_000;
const shiftIso = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

/**
 * DECISION 46 (V, 2026-09-05) — A PROCEDURE ANCHOR COMES ONLY FROM AN OT NOTE OR A `Surgery` ORDER.
 *
 * ⚠️ WHAT THE LOOSE TEST COST, MEASURED ON THE TWELVE. The first version matched
 * `/procedure|surgery|ot charge/` against `service_type`, and `Procedure` is the billing category
 * this mirror puts GRBS, nebulisation, IV cannulation, dressings, crossmatch and dialysis in.
 * SIXTEEN OF THE TWENTY procedure anchors on the cohort were set by lines like those — six by GRBS
 * alone. A finger-prick glucose is not a moment an admission turns on.
 *
 * It also silently truncated the plan. Anchors are capped at MAX_CHECKPOINTS, so the spurious
 * procedure days consumed the budget and NO `procedure_plus_4` CHECKPOINT EXISTED ANYWHERE in the
 * cohort — the follow-up window decision 43 was written to add was crowded out by nebulisations
 * before it could ever be scheduled.
 *
 * `Surgery` is matched EXACTLY (trimmed, case-insensitively), not as a substring, for the same
 * reason decision 41 matches discharge types exactly: a substring test is how `Procedure` got in.
 */
const SURGERY_SERVICE_TYPE = 'surgery';

export function isProcedureEvent(e: EpisodeEvent): boolean {
  if (e.event_type === 'ot_note') return true;
  if (e.event_type !== 'order') return false;
  const d = e.detail as Record<string, unknown>;
  return String(d?.service_type ?? '').trim().toLowerCase() === SURGERY_SERVICE_TYPE;
}

/**
 * DECISION 43 (V, 2026-09-04) — CHECKPOINTS ARE ANCHORED TO EVENTS, NOT CALENDAR DAYS.
 *
 * ⚠️ WHAT THE CALENDAR PLAN COST, AT BOTH ENDS.
 *
 *   · `cp-d0`'s cutoff was `dayStartIso(admission, 0)` — the ADMISSION INSTANT. Nothing precedes an
 *     admission, so day 0 saw the admission event and nothing else: retrieval was skipped on 10 of
 *     12 episodes and every expectation it produced was uncited. A checkpoint that cannot see the
 *     first day of an admission cannot say anything about it.
 *   · Days beyond 6 were never checkpointed at all. On IPNO-495 days 7–11 held 115 of 414 events —
 *     28% of the admission — and produced ZERO expectations; days 7, 8 and 9 generated no findings
 *     of any kind. The longest stays were the least audited.
 *
 * The anchors are the moments an admission actually turns on:
 *
 *   first_24h          admission + 24h — the first day as a WINDOW, not an instant
 *   procedure          the day of each procedure (an OT note, or a `Surgery` order — decision 46)
 *   procedure_day_N    every day after a procedure, up to the pre-discharge day (decision 52)
 *   pre_discharge      24h before discharge — the decision to send the patient home
 *   episode            unchanged: the whole admission, discharge event excluded
 *
 * Anchors falling on the same DAY collapse to one, and ANCHOR_PRIORITY decides which survives — not
 * the earlier cutoff, which is what the first version did and how IPNO-495 lost its pre-discharge
 * view of day 10 to a procedure follow-up. The total is capped at MAX_CHECKPOINTS by the same
 * priority, with the episode-level checkpoint always kept.
 *
 * ⚠️ BLINDING IS UNCHANGED IN PRINCIPLE AND RE-DERIVED PER ANCHOR: each checkpoint sees only events
 * strictly BEFORE its own cutoff, always the admission event, never the discharge event. The
 * cutoff is now a timestamp rather than a day boundary, which makes the rule easier to hold, not
 * harder: `eventsBeforeCutoff` takes the instant directly.
 */
export interface CheckpointPlanEntry {
  /** `cp-d<N>` for a daily checkpoint, `cp-episode` for the episode-level one. */
  checkpoint_id: string;
  day_index: number;
  checkpoint_type: 'daily' | 'episode';
  /** DECISION 43: what this checkpoint is anchored to. */
  anchor_kind: AnchorKind;
  /** The exact instant this checkpoint may see events before. */
  cutoff_at: string;
}

export function checkpointPlanFromEvents(a: {
  admittedAt: string;
  dischargedAt: string | null;
  losDays: number | null;
  events: EpisodeEvent[];
}): CheckpointPlanEntry[] {
  const { admittedAt, dischargedAt, events } = a;
  const los = Number.isFinite(a.losDays as number) && (a.losDays as number) > 0 ? Math.floor(a.losDays as number) : 0;
  const candidates: { cutoff: string; kind: AnchorKind }[] = [];

  // 1. the first 24 hours, as a window
  candidates.push({ cutoff: shiftIso(admittedAt, FIRST_WINDOW_HOURS * HOUR_MS), kind: 'first_24h' });

  // 5. pre-discharge — built BEFORE the procedure run, because the run stops at its day.
  const preCutoff = dischargedAt ? shiftIso(dischargedAt, -PRE_DISCHARGE_HOURS * HOUR_MS) : null;
  if (preCutoff && preCutoff > admittedAt) candidates.push({ cutoff: preCutoff, kind: 'pre_discharge' });
  const preDay = preCutoff ? dayIndexFor(admittedAt, preCutoff) : null;

  // 2-4. DECISION 52: the procedure day, then EVERY day after it until pre-discharge.
  const procedureDays = [...new Set(events.filter(isProcedureEvent)
    .map((e) => e.occurred_at).filter((t): t is string => !!t))].sort();
  for (const t of procedureDays) {
    // the END of the procedure day, so the checkpoint sees the procedure itself
    const procCutoff = shiftIso(dayStartIso(t, 0), 24 * HOUR_MS);
    candidates.push({ cutoff: procCutoff, kind: 'procedure' });
    const procDay = dayIndexFor(admittedAt, procCutoff);
    for (let n = 1; n <= MAX_PROCEDURE_RUN_DAYS; n++) {
      const cutoff = shiftIso(dayStartIso(t, 0), (n + 1) * 24 * HOUR_MS);
      const day = dayIndexFor(admittedAt, cutoff);
      if (day == null) break;
      // the run stops AT the pre-discharge day: that day is pre_discharge's, and a post-operative
      // run has nothing left to say about a patient already being sent home.
      if (preDay != null && day >= preDay) break;
      if (procDay != null && day <= procDay) continue;
      candidates.push({ cutoff, kind: `procedure_day_${n}` as AnchorKind });
    }
  }

  // ⚠️ DECISION 52 — ON A SAME-DAY COLLISION THE PROCEDURE FAMILY WINS THE LABEL. This inverts what
  // round 23 did, and deliberately: a day that is both "24 hours after admission" and "the day of
  // the operation" is, clinically, the day of the operation, and the label is what tells a reader
  // why the checkpoint exists. The cutoff instant is unchanged either way — the earliest for the
  // day — so the BLINDING does not move, only the name.
  //
  // ⚠️ ONLY THE PROCEDURE FAMILY'S PRECEDENCE CHANGES. Every other collision is decided by
  // ANCHOR_PRIORITY exactly as before, so a day that is both the first 24 hours and the
  // pre-discharge window is still labelled `first_24h` — decision 52 did not touch that pair, and
  // silently reordering it would have relabelled five of the twelve episodes' day 1.
  const dedupRank = (k: AnchorKind): number =>
    isProcedureAnchor(k) ? -1 : ANCHOR_PRIORITY[k];
  const lastMoment = dischargedAt ?? shiftIso(admittedAt, (los + 1) * 24 * HOUR_MS);
  const byDay = new Map<number, { cutoff: string; kind: AnchorKind }>();
  for (const c of candidates.sort((x, y) =>
    (dedupRank(x.kind) - dedupRank(y.kind)) || x.cutoff.localeCompare(y.cutoff))) {
    if (c.cutoff <= admittedAt || c.cutoff > lastMoment) continue;
    const day = dayIndexFor(admittedAt, c.cutoff);
    if (day == null) continue;
    const held = byDay.get(day);
    if (!held) { byDay.set(day, c); continue; }
    // the label may be upgraded to the procedure family, but the CUTOFF stays the earliest seen
    if (dedupRank(c.kind) < dedupRank(held.kind)) byDay.set(day, { cutoff: held.cutoff, kind: c.kind });
  }

  // ⚠️ THE CAP DROPS FROM THE END OF THE POST-PROCEDURE RUN, AND KEEPS pre_discharge (decision 52).
  // ANCHOR_PRIORITY orders the tiers — first window, discharge decision, procedure day, then the
  // run in order — so slicing at the cap removes the LATEST days of the run first. That is the
  // right end to lose: day 5 after an operation is further from the decision that produced it than
  // day 1, and the decision to send the patient home is never the thing dropped.
  const daily = [...byDay.entries()]
    .sort((x, y) => (ANCHOR_PRIORITY[x[1].kind] - ANCHOR_PRIORITY[y[1].kind]) || (x[0] - y[0]))
    .slice(0, MAX_CHECKPOINTS - 1)
    .sort((x, y) => x[0] - y[0])
    .map(([day, c]) => ({
      checkpoint_id: `cp-d${day}`, day_index: day, checkpoint_type: 'daily' as const,
      anchor_kind: c.kind, cutoff_at: c.cutoff,
    }));

  // The episode-level checkpoint is always kept, and always last.
  return [...daily, {
    checkpoint_id: EPISODE_CHECKPOINT_ID,
    day_index: daily.length ? daily[daily.length - 1].day_index : los,
    checkpoint_type: 'episode' as const,
    anchor_kind: 'episode' as const,
    cutoff_at: lastMoment,
  }];
}

/** Events strictly before an arbitrary cutoff INSTANT. The blinding rule, unchanged in principle:
 *  the admission event always, the discharge event never, untimestamped events excluded. */
export function eventsBeforeCutoff(events: EpisodeEvent[], cutoffIso: string): EpisodeEvent[] {
  return sortEvents(events).filter((e) => {
    if (isDischargeEvent(e)) return false;
    if (isAdmissionEvent(e)) return true;
    if (!e.occurred_at) return false;
    return e.occurred_at < cutoffIso;
  });
}

// ── component_json ({name, valueString}) ─────────────────────────────────────────────────────

export interface ComponentEntry { name: string; valueString: string }

/**
 * Parse the `component_json` TEXT column into {name, valueString} pairs. Tolerates a value that
 * arrives already parsed (some drivers), a JSON string, junk, or null — an unreadable component
 * block yields no pairs rather than throwing, because one malformed note must not fail an episode.
 */
export function parseComponentJson(raw: unknown): ComponentEntry[] {
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return [];
    try { arr = JSON.parse(t); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  const out: ComponentEntry[] = [];
  for (const el of arr) {
    if (!el || typeof el !== 'object') continue;
    const o = el as Record<string, unknown>;
    const name = o.name == null ? '' : String(o.name);
    if (!name) continue;
    const valueString = o.valueString == null ? '' : String(o.valueString);
    out.push({ name, valueString });
  }
  return out;
}

export function componentValue(entries: ComponentEntry[], name: string): string | null {
  for (const e of entries) if (e.name === name && e.valueString !== '') return e.valueString;
  return null;
}

/**
 * The names excluded from a note summary (PRD §3.2.3). The first four are test artefacts left in
 * a live clinical template and empty on every row; the last three are identifiers and opaque tag
 * blobs, not narrative.
 */
export const NOTE_SUMMARY_EXCLUDED_NAMES = [
  'esfewqf', 'Inver43', 'fycjtkuvyj', 'liubf', 'observationId', 'doctor_id', 'tag_data',
  // ROUND 20: `signnur` is a 15 kB base64 PNG of a signature. It was reaching note summaries and
  // only the 4,000-character cap was keeping it out of the prompts — by luck, not by design.
  'signnur',
] as const;

/**
 * ROUND 14 ITEM 9 — A FIELD WHOSE NAME SAYS IT HOLDS A PERSON.
 *
 * `kx_clinical_template_ot_notes` carries a component named `ot_asst`, and IPNO-416's OT note put
 * A THEATRE ASSISTANT'S FULL NAME in it — deliberately not quoted here, because this is a public
 * repository and a comment explaining why staff names must not be stored is the last place to
 * reproduce one. That reached `real_course`, which is stored in a table whose own column says
 * `de_identified = TRUE`. Theatre staff, not the patient — but a name is a name, the claim on the
 * row was false while it was there, and this repository has had PHI history rewritten once already.
 *
 * ⚠️ MATCHED ON THE FIELD NAME, NOT ON THE VALUE, and that is the lesson from the retrieval
 * whitelist directly above: a rule that inspects VALUES can only remove the names someone has
 * already seen. `ot_asst` was not on any list — nothing had noticed it — but its NAME says plainly
 * what it holds, and so will the next one.
 *
 * The surgeon and the note's author are NOT lost by this: both are read from real columns
 * (`surgeon`, `finalized_by_username`) into the event's attribution fields, where §5 needs them
 * and where the UI joins names at render time. This removes a person from the free-text blob that
 * gets stored and sent to a model, not from the attribution path.
 */
const PERSON_FIELD_NAME = /(^|[_\s-])(asst|assistant|assisted|surgeon|anaesthetist|anesthetist|anaesthesiologist|anesthesiologist|nurse|nursing_staff|doctor|dr|consultant|physician|technician|scrub|staff|attendant|performed|signed|witness|informant|relative|attendee|by|name)([_\s-]|$)/i;

export function isPersonFieldName(name: string): boolean {
  return PERSON_FIELD_NAME.test(String(name ?? ''));
}

/**
 * ⚠️ THE CLINICAL-NARRATIVE WHITELIST (item 7, third attempt). The first two attempts STRIPPED a
 * blob: take the whole concatenated note and remove identifiers, then names, then non-words. Each
 * pass removed what it had been told about and let the next thing through — `ABSTACK`, `SODIUM`,
 * a literal `false`, and the RMO's name all reached retrieval anyway, because a deny-list can only
 * ever exclude what someone already noticed.
 *
 * This inverts it. A component field contributes to a retrieval query only if its NAME is on this
 * list. `doctor`, `role`, `speciality_code`, `isDischarge`, `tag_data` and every future field
 * nobody has seen yet are excluded by DEFAULT, because they are not on it.
 *
 * The opaque template ids are here because the reference measured them as where the narrative
 * actually lives (§1.2: "Clinical narrative sits in fields named T-3, T-35, and T-2").
 *
 * ⚠️ ROUND 20 ITEM 3 — THE WHITELIST WAS ALSO EMPTYING THE QUERY, and the fields below were added
 * by SAMPLING db13 rather than by guessing at names.
 *
 * Five checkpoints across three Group-1 episodes ran with zero excerpts and every entry uncited;
 * IPNO-573 formed 40 expectations on no evidence at all. Its day-0 initial assessment contributed
 * nothing, because none of that template's field names was on this list.
 *
 * WHAT THE SAMPLING FOUND (kx_clinical_template_initial_assessment_adults, 188 rows):
 *   histoyerjfj (1,070 chars) · risky (1,156) · vulnerass (1,929)   — narrative, wrapped in HTML
 *                                                                     TABLES, hence stripMarkup
 *   pamgjdk (2,042)   — pain assessment, HTML fragments
 *   loc (32)          — level of consciousness, a JSON array: ["Alert"]
 *   signnur (14,970)  — ⚠️ A BASE64 PNG SIGNATURE IMAGE. Never whitelisted, and now excluded from
 *                        note summaries too: it is 15 kB of `data:image/png;base64,...` that only
 *                        the 4,000-character summary cap was keeping out of the prompts, by luck.
 *
 * AND (kx_clinical_template_shift_handovers, 1,573 rows):
 *   nhc16 (1,100 non-empty) — the standing problem list: "K/C/O DM,HTN,CKD ON MM & MHD"
 *   nhc13 (1,306)           — consciousness: "conscious AND ORIENTED"
 *   nhc05 (8,800)           — NOT included: a care-checklist JSON table of GIVEN / N/A rows
 *   nursing_handover, nursing_receiving — ⚠️ NOT included: they hold STAFF NAMES.
 */
export const QUERY_NARRATIVE_FIELDS: readonly string[] = [
  'T-2', 'T-3', 'T-35',
  'patient_remarks', 'chief_complaints', 'presenting_complaints', 'complaints',
  'history_of_present_illness', 'hopi', 'diagnosis', 'provisional_diagnosis',
  'final_diagnosis', 'impression', 'indication', 'examination', 'findings',
  'procedure', 'procedure_details', 'plan_of_management', 'treatment_plan',
  // initial assessment (round 20 item 3a) — sampled, then MEASURED and cut back.
  //
  // ⚠️ `histoyerjfj`, `risky`, `vulnerass` and `pamgjdk` were on this list for one run and are off
  // it again. Sampling showed they hold narrative wrapped in HTML tables; stripping the tags showed
  // what the tables actually contain, which is FORM SCAFFOLDING — "Sr. No. Categories Yes No 1 Age
  // more than 65 years NO 2 Physically Challanged NO". On IPNO-573 that filled 641-1,200 characters
  // of every query from day 1 on, and off-topic excerpts went from 11 to 37 across the episode.
  // An empty query was replaced by a worse one: retrieval matching on checklist labels.
  //
  // `loc` stays. It is a JSON array of one clinical word (["Alert"]) — small, clean, and enough to
  // keep the whitelist non-empty for this template so the fallback does not fire on it either.
  // The clinical signal for the early days comes from the handover fields below instead, which is
  // what item 3b was for.
  'loc',
  // shift handover (round 20 item 3b) — the problem list and the consciousness line only
  'nhc16', 'nhc13',
];

/**
 * ROUND 20 ITEM 3c — HOW THE TENSION IS RESOLVED: A BOUNDED FALLBACK, NOT A BROADER WHITELIST.
 *
 * The whitelist exists because three strip-based attempts failed to keep inventory noise out of
 * retrieval (round 7 item 7). Widening it to "anything that looks like prose" would walk straight
 * back into that. But a deny-by-default list has a second failure mode the first three attempts did
 * not have: when a template's fields are ALL unknown, the query is not noisy — it is EMPTY, and an
 * empty query is not a safe default. It produced 40 expectations with no evidence behind them.
 *
 * So the whitelist stays authoritative, and a fallback runs only when it yields NOTHING for a
 * component block. The fallback is deliberately more suspicious than the whitelist:
 *   · person-named fields are dropped by the same `isPersonFieldName` rule that guards summaries;
 *   · markup, JSON and data URIs are stripped;
 *   · anything still containing a `data:` URI or base64 run is dropped whole;
 *   · the result is capped hard, because a fallback should contribute a hint, not a document.
 *
 * A known template is therefore as tightly controlled as before. An unknown one contributes
 * something cleaned rather than nothing at all, and the next unknown template after this one does
 * not need a code change to be audited with evidence.
 */
const DATA_URI_OR_BASE64 = /data:[a-z/+.-]+;base64,|[A-Za-z0-9+/]{120,}={0,2}/i;

/** Strip HTML tags, entities and JSON punctuation down to readable words. */
export function stripMarkup(text: string): string {
  const noTags = String(text ?? '').split(/<[^>]*>/).join(' ');
  const noEntities = noTags.split(/&[a-z]+;|&#\d+;/i).join(' ');
  // NOT the comma: it is prose punctuation ("K/C/O DM,HTN,CKD"), and removing it made the query
  // less readable without making it match differently — retrieval tokenises on non-alphanumerics.
  const noJson = Array.from(noEntities, (c) => ('{}[]":\\'.includes(c) ? ' ' : c)).join('');
  return collapseSpaces(noJson);
}

/**
 * The retrieval-safe narrative of one component block: whitelisted fields only, values only, no
 * field names, no identifiers, no person fields. Bounded and boring by construction.
 */
export const QUERY_FALLBACK_CAP = 240;

export function queryNarrativeFrom(entries: ComponentEntry[], cap = 400): string {
  const allow = new Set(QUERY_NARRATIVE_FIELDS.map((f) => f.toLowerCase()));
  const usable = (v: string) => !!v && !/^(true|false|null|\d+(\.\d+)?)$/i.test(v);
  const parts: string[] = [];
  for (const e of entries) {
    if (!allow.has(e.name.toLowerCase())) continue;
    const v = stripMarkup(e.valueString.trim());
    if (!usable(v)) continue;
    if (DATA_URI_OR_BASE64.test(v)) continue;
    parts.push(v);
  }
  if (parts.length) return collapseSpaces(parts.join(' ')).slice(0, cap);

  // ── the bounded fallback (item 3c). Only when the whitelist matched NOTHING at all. ──
  const fallback: string[] = [];
  for (const e of entries) {
    if (isPersonFieldName(e.name)) continue;
    const raw = e.valueString.trim();
    if (DATA_URI_OR_BASE64.test(raw)) continue;
    const v = stripMarkup(raw);
    if (!usable(v) || v.length < 8) continue;
    fallback.push(v);
  }
  return collapseSpaces(fallback.join(' ')).slice(0, QUERY_FALLBACK_CAP);
}

/**
 * A note's `summary`: every non-empty valueString in component_json except the excluded names,
 * joined. The caller passes the de-identifier; this function never sees an identity to scrub
 * against, which is exactly why the scrub is an argument rather than a step (the stay-library idiom).
 */
export function noteSummaryFrom(entries: ComponentEntry[], deid: (t: string) => string, cap = 4000): string {
  const skip = new Set<string>(NOTE_SUMMARY_EXCLUDED_NAMES as readonly string[]);
  const parts: string[] = [];
  for (const e of entries) {
    if (skip.has(e.name)) continue;
    // ITEM 9: a field whose NAME says it holds a person does not enter a de-identified table.
    if (isPersonFieldName(e.name)) continue;
    const v = e.valueString.trim();
    if (!v) continue;
    parts.push(`${e.name}: ${v}`);
  }
  const joined = parts.join(' · ');
  if (!joined) return '';
  return collapseSpaces(deid(joined)).slice(0, cap);
}

// ── free-text formatting ─────────────────────────────────────────────────────────────────────

/**
 * Collapse runs of whitespace. Written with split/join rather than `String.replace` ON PURPOSE:
 * PRD §13 item 12 makes "no `replace(` appears in this file" a source-read test, so the
 * no-id-rewriting rule is checkable by READING the file rather than by trusting it. The three
 * places this file reformats a string — this one, the `Dr.` collapse below, and the drug-name slug
 * at the end — touch FREE TEXT and DISPLAY NAMES only. No id is reformatted here or anywhere else
 * in this engine, and the same test file pins that behaviourally as well as textually: an `IPNO-`
 * encounter id fed through assembly comes back out byte-identical.
 */
export function collapseSpaces(t: string): string {
  return t.split(/\s+/).filter(Boolean).join(' ').trim();
}

// ── authorship (PRD §5) ──────────────────────────────────────────────────────────────────────

/**
 * Normalise `finalized_by_username`: trim whitespace and collapse `Dr.` to `Dr`. NOTHING MORE.
 * The field is a free-text display name whose hygiene is already broken in the source (one row
 * reads `Dr Dietician` where the author is a named dietitian); repairing it here would invent a
 * person, so the rule is deliberately two operations long.
 */
export function normalizeAuthorName(raw: unknown): string | null {
  if (raw == null) return null;
  const t = String(raw).trim();
  if (!t) return null;
  const out = collapseSpaces(t.split('Dr.').join('Dr'));
  return out || null;
}

// ── order events (decisions 17 and 28) ───────────────────────────────────────────────────────

export interface BillingOrderRow {
  _doc_id?: unknown;
  visit_id_admission_id?: unknown;
  order_date_time?: unknown;
  service_type?: unknown;
  department?: unknown;
  service_item_name?: unknown;
  ordered_item_name?: unknown;
  ordered_qty?: unknown;
  quantity?: unknown;
  net_amt?: unknown;
  status?: unknown;
  order_no?: unknown;
}

export const PHARMACY_SERVICE_TYPE = 'Pharmacy';
export const NON_PHARMACY_ORDERS_PER_DAY_CAP = 60;

const str = (v: unknown): string => (v == null ? '' : String(v).trim());

/**
 * Order events for one admission.
 *
 * Pharmacy rows (`service_type = 'Pharmacy'`) roll up to ONE event per (day, ordered_item_name)
 * with the row count in `detail.count`, because a five-day antibiotic is 15 identical billing
 * rows and prompting on all of them buys nothing. Every other row is one event, capped at 60 per
 * day in `order_date_time` order, with `detail.truncated_count` on the last kept event of that day.
 *
 * NO CATEGORY FIELD and no `kx_medicine_items` join: repairing the blank pharmacy category
 * resolves 1.9% of rows (DB addendum A6), which is not a category, it is noise with a name.
 */
export function buildOrderEvents(rows: BillingOrderRow[], admissionIso: string): EpisodeEvent[] {
  const timed = rows.map((r) => {
    const occurred_at = isoFromTimestamp(r.order_date_time);
    return { r, occurred_at, day_index: dayIndexFor(admissionIso, occurred_at) };
  });

  const out: EpisodeEvent[] = [];

  // pharmacy: one event per (day, ordered_item_name)
  const pharmBuckets = new Map<string, { day: number; item: string; count: number; first: string | null; docIds: string[]; qty: number }>();
  for (const t of timed) {
    if (str(t.r.service_type) !== PHARMACY_SERVICE_TYPE) continue;
    const item = str(t.r.ordered_item_name) || str(t.r.service_item_name) || '(unnamed pharmacy item)';
    const key = `${t.day_index}::${item}`;
    const b = pharmBuckets.get(key);
    const q = Number(t.r.ordered_qty ?? t.r.quantity);
    if (b) {
      b.count += 1;
      if (Number.isFinite(q)) b.qty += q;
      if (t.occurred_at && (!b.first || t.occurred_at < b.first)) b.first = t.occurred_at;
      if (b.docIds.length < 25 && str(t.r._doc_id)) b.docIds.push(str(t.r._doc_id));
    } else {
      pharmBuckets.set(key, {
        day: t.day_index, item, count: 1, first: t.occurred_at,
        docIds: str(t.r._doc_id) ? [str(t.r._doc_id)] : [], qty: Number.isFinite(q) ? q : 0,
      });
    }
  }
  for (const [key, b] of Array.from(pharmBuckets.entries()).sort((a, z) => (a[0] < z[0] ? -1 : 1))) {
    out.push({
      event_id: `order-pharm-${b.day}-${slugForId(b.item)}`,
      occurred_at: b.first,
      day_index: b.day,
      event_type: 'order',
      summary: `Pharmacy order · ${b.item}${b.count > 1 ? ` × ${b.count} order lines` : ''}`,
      detail: { service_type: PHARMACY_SERVICE_TYPE, ordered_item_name: b.item, count: b.count, total_qty: b.qty, rolled_up: true, source_record_ids: b.docIds },
      author_name: null,
      author_role: null,
      responsible_clinician_id: null,
      provenance: { source_table: 'kx_billing_records', source_record_id: b.docIds[0] ?? key, source_timestamp: b.first },
      evidence_tier: 'A',
    });
  }

  // non-pharmacy: one event each, capped per day
  const byDay = new Map<number, typeof timed>();
  for (const t of timed) {
    if (str(t.r.service_type) === PHARMACY_SERVICE_TYPE) continue;
    const list = byDay.get(t.day_index) ?? [];
    list.push(t);
    byDay.set(t.day_index, list);
  }
  for (const day of Array.from(byDay.keys()).sort((a, z) => a - z)) {
    const list = (byDay.get(day) ?? []).sort((a, z) => String(a.occurred_at ?? '').localeCompare(String(z.occurred_at ?? '')));
    const kept = list.slice(0, NON_PHARMACY_ORDERS_PER_DAY_CAP);
    const dropped = list.length - kept.length;
    kept.forEach((t, i) => {
      const item = str(t.r.ordered_item_name) || str(t.r.service_item_name) || '(unnamed order)';
      const detail: Record<string, unknown> = {
        service_type: str(t.r.service_type) || null,
        department: str(t.r.department) || null,
        ordered_item_name: str(t.r.ordered_item_name) || null,
        service_item_name: str(t.r.service_item_name) || null,
        ordered_qty: t.r.ordered_qty ?? null,
        quantity: t.r.quantity ?? null,
        net_amt: t.r.net_amt ?? null,
        status: str(t.r.status) || null,
        order_no: str(t.r.order_no) || null,
      };
      if (dropped > 0 && i === kept.length - 1) detail.truncated_count = dropped;
      out.push({
        event_id: `order-${str(t.r._doc_id) || `${day}-${i}`}`,
        occurred_at: t.occurred_at,
        day_index: day,
        event_type: 'order',
        summary: `${str(t.r.service_type) || 'Order'} · ${item}`,
        detail,
        author_name: null,
        author_role: null,
        responsible_clinician_id: null,
        provenance: { source_table: 'kx_billing_records', source_record_id: str(t.r._doc_id) || `${day}-${i}`, source_timestamp: t.occurred_at },
        evidence_tier: 'A',
      });
    });
  }

  return sortEvents(out);
}

/**
 * ⚠️ PROMPT SHAPING ONLY. THIS NEVER TOUCHES `real_course` OR THE RESOLVER.
 *
 * IPNO-416 (LOS 3, 5 checkpoints, 269 billing rows, 17 labs) hit the 800 s invocation cap and left
 * nothing behind; IP-1286 (LOS 2, 4 checkpoints, 204 billing rows) ran in 227 s. One extra
 * checkpoint cannot cost 3.5×, so the driver is EVENT VOLUME — every checkpoint re-renders the
 * whole order stream, and the cost is quadratic in an episode's billing lines because each of N
 * checkpoints reads O(N) of them.
 *
 * So the PROMPTS get a rolled-up view: pharmacy and consumable billing lines collapse to one line
 * per day carrying the count and the distinct item names. Everything a clinician would reason about
 * individually — notes, labs, procedures, transfers, OT notes, the admission and the discharge —
 * stays one event per record.
 *
 * WHAT IS NOT AFFECTED, and this is the whole safety of it: `real_course` is stored as assembled,
 * every event intact; the deterministic resolver matches against that full list, so a drug matcher
 * still finds a drug ordered once on day 2. Only what the MODEL READS is condensed. `prompt_events`
 * and `assembled_events` are both recorded so the ratio is visible rather than assumed.
 */
const PROMPT_ROLLUP_SERVICE = /pharmacy|consumable|surgical|implant|consignment|fmcg|general|room|bed|nursing|laundry|kit|linen|attendant/i;

/** How many of a day's distinct postings are enumerated before the rest are counted in one phrase.
 *  Bounded so the batch structure is visible without the roll-up growing back into a per-line list. */
export const MAX_POSTINGS_RENDERED = 6;

function rollupServiceType(e: EpisodeEvent): boolean {
  if (e.event_type !== 'order') return false;
  const st = String((e.detail as Record<string, unknown>)?.service_type ?? '');
  // an unnamed service_type rolls up too: an order this engine cannot classify is not one a
  // clinician can reason about from its name either
  return !st.trim() || PROMPT_ROLLUP_SERVICE.test(st);
}

/**
 * The event list as the PROMPTS see it. Order events of the rolled-up classes collapse to one
 * synthetic event per day; everything else passes through untouched and in order.
 */
export function summariseEventsForPrompt(events: EpisodeEvent[]): EpisodeEvent[] {
  const kept: EpisodeEvent[] = [];
  const byDay = new Map<number, EpisodeEvent[]>();
  for (const e of events) {
    if (rollupServiceType(e)) byDay.set(e.day_index, [...(byDay.get(e.day_index) ?? []), e]);
    else kept.push(e);
  }
  for (const [day, group] of byDay) {
    // ROUND 14 ITEM 1 — A SAME-TIMESTAMP BATCH IS ONE POSTING, AND MUST LOOK LIKE ONE.
    //
    // On IPNO-416 the diff pass read a 15-line pharmacy batch posted on the discharge morning —
    // which also held syringes, an enema, nebulisers and thiamine — as "possible septic shock with
    // arrhythmia", in a patient who went home normally four hours later. The lines were already
    // collapsed to one event, but their names were rendered as a flat comma list, and a flat list
    // of drugs reads like a sequence of decisions. It was neither: it was one clerk posting one
    // batch at one instant.
    //
    // The postings are therefore kept as postings — grouped by exact timestamp, counted, and
    // labelled — inside the SAME single event, so the prompt learns the batch structure without
    // the event count growing back into the volume the day roll-up exists to bound.
    const byPosting = new Map<string, EpisodeEvent[]>();
    for (const e of group) {
      const key = e.occurred_at ?? '(no timestamp)';
      byPosting.set(key, [...(byPosting.get(key) ?? []), e]);
    }
    const nameOf = (e: EpisodeEvent) => String((e.detail as Record<string, unknown>)?.ordered_item_name
      ?? (e.detail as Record<string, unknown>)?.service_item_name ?? '').trim();
    const names = Array.from(new Set(group.map(nameOf).filter(Boolean)));
    const first = group.map((e) => e.occurred_at).filter(Boolean).sort()[0] ?? null;
    const postings = [...byPosting.entries()].sort(([a], [b]) => a.localeCompare(b));
    const rendered = postings.slice(0, MAX_POSTINGS_RENDERED).map(([ts, lines]) => {
      const items = Array.from(new Set(lines.map(nameOf).filter(Boolean)));
      return `posted together at ${ts} — ${lines.length} line${lines.length === 1 ? '' : 's'}`
        + (items.length ? `: ${items.slice(0, 40).join(', ')}` : '');
    });
    const spill = postings.length - rendered.length;
    kept.push({
      event_id: `orders-day-${day}`,
      occurred_at: first,
      day_index: day,
      event_type: 'order',
      summary: `${group.length} pharmacy/consumable BILLING line${group.length === 1 ? '' : 's'} on day ${day}, `
        + `in ${postings.length} posting${postings.length === 1 ? '' : 's'}. `
        + 'Each posting is ONE billing entry made at one moment — a batch, not a sequence of clinical decisions, '
        + 'and a dispensing record rather than evidence that anything was administered.'
        + (rendered.length ? ` ${rendered.join(' | ')}` : '')
        + (spill > 0 ? ` | and ${spill} further posting${spill === 1 ? '' : 's'} on this day` : ''),
      detail: {
        rolled_up_for_prompt: true, line_count: group.length, distinct_items: names.length,
        posting_count: postings.length,
      },
      author_name: null, author_role: null, responsible_clinician_id: null,
      provenance: { source_table: 'kx_billing_records', source_record_id: `day-${day}-rollup`, source_timestamp: first },
      evidence_tier: 'A',
    });
  }
  return sortEvents(kept);
}

/**
 * A filename-safe slug for an EVENT ID SEGMENT built from an item NAME — never from an id.
 * Ids are copied verbatim everywhere in this engine; this touches drug names only.
 */
export function slugForId(itemName: string): string {
  const chars = Array.from(itemName.toLowerCase(), (c) => (/[a-z0-9]/.test(c) ? c : ' '));
  return chars.join('').trim().split(/\s+/).filter(Boolean).join('-').slice(0, 48) || 'item';
}
