/**
 * lib/care-tracks-core.ts — Care Conversation Brief v2: TRACK layer core (pure).
 *
 * PURE, dependency-free (strip-types testable). A "track" is the care-manager workflow a member
 * is worked along (fever/medical-management, post-hospital OPD, AIHS chronic care, …). Each track
 * has an ANCHOR, a set of EXPECTATIONS auto-evaluated from the member's artifacts, and a view
 * template. This module owns: the track registry, the track key derivation from the care-manager
 * form (`individuals-health_forms.care_reachout__reason` / `type`, db13), injection-safe SQL, the
 * jsonb/array parsers, and the deterministic expectations engine. The wired reads live in
 * lib/care-tracks.ts.
 *
 * ADDITIVE: nothing here touches CCB v1. The member dossier / grounded brief / walled pitch are
 * unchanged; this layer wraps them. Deterministic — no LLM. Read-only; ids validated before SQL.
 *
 * NOTE (assumptions): thresholds below (fever day ≥5, danger-sign symptom set, HbA1c 6-month
 * recency) are our best inference pending the care-manager lead's Monday review — see
 * CDMSS-CCB-v2-TRACK-BASED-PRD-v1.0.md §9. They are isolated here so they are easy to tune.
 */

// ── validators (mirrors ccb-dossier-core, inlined to keep the test loader dependency-free) ──
export const isUid = (u: string): boolean => /^[A-Za-z0-9_-]{6,64}$/.test(u);

// ── Track registry ──────────────────────────────────────────────────────────────
export type TrackKey =
  | 'fever' | 'posthosp' | 'aihs'          // deep (v1)
  | 'referral' | 'radiology' | 'postipd' | 'engagement' | 'unknown'; // stubs

export interface TrackDef {
  key: TrackKey;
  label: string;      // full label for the selector
  short: string;      // chip label
  anchor: string;     // one line — what the view orients around
  deep: boolean;      // fully built in v1?
}

export const TRACKS: Record<TrackKey, TrackDef> = {
  fever:      { key: 'fever',      label: 'Fever · Medical Mgmt', short: 'Fever',        anchor: 'Last prescription + today’s symptoms; admission gatekeeping.', deep: true },
  posthosp:   { key: 'posthosp',   label: 'Post-hospital OPD',    short: 'Post-hospital', anchor: 'Prescribed follow-up tests/referrals and whether they’re booked.', deep: true },
  aihs:       { key: 'aihs',       label: 'AIHS · Chronic',       short: 'AIHS',         anchor: 'Whole longitudinal picture; chronic markers + complication risk.', deep: true },
  referral:   { key: 'referral',   label: 'In-person referral',   short: 'Referral',     anchor: 'Referred but not booked — get them to an Even unit.', deep: false },
  radiology:  { key: 'radiology',  label: 'Radiology follow-up',  short: 'Radiology',    anchor: 'Prescribed imaging not yet booked.', deep: false },
  postipd:    { key: 'postipd',    label: 'Post-IPD',             short: 'Post-IPD',     anchor: 'Post-discharge recovery, readmission watch.', deep: false },
  engagement: { key: 'engagement', label: 'Engagement (day 75/150/270)', short: 'Engagement', anchor: 'Longitudinal membership touchpoints.', deep: false },
  unknown:    { key: 'unknown',    label: 'General',              short: 'General',      anchor: 'No specific track assigned.', deep: false },
};

export const DEEP_TRACKS: TrackKey[] = ['fever', 'posthosp', 'aihs'];

/** Map a care-manager form (reason + type) to a track key. `type` wins for POST_IPD/INBOUND. */
export function trackFromReasonType(reason: string | null, type: string | null): TrackKey {
  const t = (type || '').toUpperCase();
  if (t === 'POST_IPD') return 'postipd';
  const r = (reason || '').toUpperCase();
  switch (r) {
    case 'FEVER_PRESCRIPTION': return 'fever';
    case 'POST_HOSPITAL_FOLLOWUP': return 'posthosp';
    case 'IHS_CONSULTATION': return 'aihs';
    case 'IN_PERSON_REFERRAL_NOT_BOOKED': return 'referral';
    case 'RADIOLOGY_REQUEST_NOT_BOOKED': return 'radiology';
    case 'YEAR_END_REACHOUT':
    case 'DAY_SEVENTY_FIVE':
    case 'DAY_ONE_HUNDRED_FIFTY':
    case 'DAY_TWO_HUNDRED_SEVENTY':
    case 'DAY_TWO_HUNDRED_TEN': return 'engagement';
    default: return t === 'INBOUND' ? 'unknown' : 'unknown';
  }
}

// ── SQL (pure, injection-safe) ───────────────────────────────────────────────────
const HF_TABLE = '"individuals-health_forms"';
/** The member key on health_forms is `uid` (the individual uid — same namespace as `individuals`). */
export function healthFormsSql(individualUid: string, limit = 40): string {
  if (!isUid(individualUid)) throw new Error('bad individual uid');
  const lim = Math.max(1, Math.min(120, Math.floor(limit)));
  const cols = [
    `type`, `care_reachout__reason AS reason`,
    `to_char(created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS form_date`,
    `care_reachout__prescription_uid AS prescription_uid`,
    `care_reachout__fever_form_info__day_of_fever AS fever_day`,
    `care_reachout__fever_form_info__temperature AS fever_temp`,
    `care_reachout__fever_form_info__symptoms AS fever_symptoms`,
    `care_reachout__fever_form_info__icd_codes AS fever_icd`,
    `care_reachout__is_recovered AS is_recovered`,
    `care_reachout__referral_outcome AS referral_outcome`,
    `care_reachout__test_outcome AS test_outcome`,
    `care_reachout__patient_reported_health_status AS health_status`,
    `care_reachout__post_hospital_form_info__followups AS followups`,
    `care_reachout__post_hospital_form_info__prescription_url AS ph_prescription_url`,
    `care_reachout__post_hospital_form_info__next_followup_data AS ph_next_followup`,
    `care_reachout__ihs_consultation AS ihs`,
  ].join(', ');
  return `SELECT ${cols} FROM ${HF_TABLE}`
    + ` WHERE uid = '${individualUid}' AND is_draft = false`
    + ` ORDER BY created_at DESC LIMIT ${lim}`;
}

/** HbA1c diagnostics for the AIHS marker trend (no user input — fixed LIKE patterns). */
export function hba1cDiagnosticsSql(individualUid: string, limit = 8): string {
  if (!isUid(individualUid)) throw new Error('bad individual uid');
  const lim = Math.max(1, Math.min(30, Math.floor(limit)));
  const dateExpr = `left(coalesce(collection_date, created_at, uploaded_at), 10)`;
  return `SELECT ${dateExpr} AS report_date, document_name`
    + ` FROM "individuals-diagnostic_reports"`
    + ` WHERE _parent_id = '${individualUid}' AND is_draft = false`
    + ` AND (document_name ILIKE '%hba1c%' OR document_name ILIKE '%glycos%' OR document_name ILIKE '%glycated%')`
    + ` ORDER BY coalesce(collection_date, created_at, uploaded_at) DESC LIMIT ${lim}`;
}

// ── parsers (tolerant: metabase returns jsonb as JS, arrays as JS or text) ────────
const asStr = (v: unknown): string | null => (v == null ? null : String(v));
const asNum = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v); return Number.isFinite(n) ? n : null;
};

export function parseStrArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return [];
    if (s.startsWith('[')) { try { const p = JSON.parse(s); return Array.isArray(p) ? p.map(String).filter(Boolean) : []; } catch { /* fall */ } }
    // Postgres text array form: {a,b,c}
    if (s.startsWith('{') && s.endsWith('}')) return s.slice(1, -1).split(',').map((x) => x.replace(/^"|"$/g, '').trim()).filter(Boolean);
    return [s];
  }
  return [];
}

function asJson(v: unknown): unknown {
  if (v == null) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  return v;
}

export interface FollowupItem { name: string; type: string | null; booked: boolean; completed: boolean; }

/** post_hospital_form_info.followups → normalized items, DEDUPED by name+type (real data repeats
 *  the same order across touchpoints). On collision the best status wins (completed > booked). */
export function parseFollowups(v: unknown): FollowupItem[] {
  const j = asJson(v);
  if (!Array.isArray(j)) return [];
  const byKey = new Map<string, FollowupItem>();
  for (const it of j) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const name = asStr(o.name);
    if (!name) continue;
    const type = asStr(o.type);
    const completed = o.completed === true;
    const booked = completed || o.chart_booked_at_hospital === true || o.booked === true;
    const key = `${name.toLowerCase().trim()}|${(type || '').toLowerCase()}`;
    const prev = byKey.get(key);
    if (prev) { prev.completed = prev.completed || completed; prev.booked = prev.booked || booked; }
    else byKey.set(key, { name, type, booked, completed });
  }
  return Array.from(byKey.values());
}

/** next_followup_data is a jsonb object: a date (several possible keys) OR a "not required" reason.
 *  Tolerant of a raw date string, a JSON-object string, or an already-parsed object. */
const isDateish = (s: string): boolean => /^\d{4}-\d{2}-\d{2}/.test(s);
export function parseNextFollowup(v: unknown): { date: string | null; note: string | null } {
  if (v == null) return { date: null, note: null };
  let obj: unknown = v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return { date: null, note: null };
    if (s.startsWith('{')) { try { obj = JSON.parse(s); } catch { return { date: null, note: null }; } }
    else return isDateish(s) ? { date: s, note: null } : { date: null, note: s };
  }
  if (obj && typeof obj === 'object') {
    const o = obj as Record<string, unknown>;
    const date = asStr(o.date) || asStr(o.next_followup_date) || asStr(o.datetime) || asStr(o.followup_date) || asStr(o.next_followup);
    const note = asStr(o.reason_for_no_followup);
    const validDate = date && isDateish(date) ? date : null;
    return { date: validDate, note: validDate ? null : (note || null) };
  }
  return { date: null, note: null };
}

// ── raw form row + coercion ──────────────────────────────────────────────────────
export interface HealthFormRow {
  type: string | null;
  reason: string | null;
  date: string | null;
  prescriptionUid: string | null;
  feverDay: number | null;
  feverTemp: number | null;
  feverSymptoms: string[];
  isRecovered: boolean | null;
  referralOutcome: string | null;
  followups: FollowupItem[];
  phPrescriptionUrl: string | null;
  phNextFollowup: string | null;
  phNextFollowupNote: string | null;
  ihsNextFollowup: string | null;
}

export function mapFormRow(r: Record<string, unknown>): HealthFormRow {
  const ph = parseNextFollowup(r.ph_next_followup);
  const ihs = parseNextFollowup(r.ihs);
  return {
    type: asStr(r.type),
    reason: asStr(r.reason),
    date: asStr(r.form_date),
    prescriptionUid: asStr(r.prescription_uid),
    feverDay: asNum(r.fever_day),
    feverTemp: asNum(r.fever_temp),
    feverSymptoms: parseStrArray(r.fever_symptoms),
    isRecovered: r.is_recovered == null ? null : r.is_recovered === true,
    referralOutcome: asStr(r.referral_outcome),
    followups: parseFollowups(r.followups),
    phPrescriptionUrl: asStr(r.ph_prescription_url),
    phNextFollowup: ph.date,
    phNextFollowupNote: ph.note,
    ihsNextFollowup: ihs.date,
  };
}

/** Auto-suggested track from the most recent form (rows are DESC by date). */
export function autoTrack(rows: HealthFormRow[]): TrackKey {
  if (!rows.length) return 'unknown';
  return trackFromReasonType(rows[0].reason, rows[0].type);
}

// ── track contexts (what each track's panels render) ─────────────────────────────
export interface FeverTrajPoint { date: string | null; day: number | null; temp: number | null; }
export interface FeverContext {
  latestDay: number | null; latestTemp: number | null; symptoms: string[];
  lastFormDate: string | null; recovered: boolean | null; dispositionRecorded: boolean;
  trajectory: FeverTrajPoint[]; prescriptionUid: string | null;
}
export interface PosthospContext { items: FollowupItem[]; nextFollowup: string | null; nextFollowupNote: string | null; prescriptionUrl: string | null; }
export interface AihsContext { hba1c: number | null; hba1cDate: string | null; nextFollowup: string | null; }

const DANGER_SIGNS = ['vomiting', 'breathless', 'short of breath', 'shortness of breath', 'bleeding', 'rash', 'drowsy', 'altered', 'seizure', 'severe abdominal pain', 'dehydration', 'unable to eat', 'not passing urine'];

export function buildFeverContext(rows: HealthFormRow[]): FeverContext {
  const fever = rows.filter((r) => trackFromReasonType(r.reason, r.type) === 'fever');
  const latest = fever[0] || null;
  const trajectory: FeverTrajPoint[] = fever
    .filter((r) => r.feverDay != null || r.feverTemp != null)
    .map((r) => ({ date: r.date, day: r.feverDay, temp: r.feverTemp }))
    .reverse(); // oldest → newest for the chart
  return {
    latestDay: latest?.feverDay ?? null,
    latestTemp: latest?.feverTemp ?? null,
    symptoms: latest?.feverSymptoms ?? [],
    lastFormDate: latest?.date ?? null,
    recovered: latest?.isRecovered ?? null,
    dispositionRecorded: !!(latest && (latest.isRecovered != null || latest.referralOutcome)),
    trajectory,
    prescriptionUid: latest?.prescriptionUid ?? null,
  };
}

export function buildPosthospContext(rows: HealthFormRow[]): PosthospContext {
  const ph = rows.filter((r) => trackFromReasonType(r.reason, r.type) === 'posthosp');
  const latest = ph.find((r) => r.followups.length) || ph[0] || null;
  return {
    items: latest?.followups ?? [],
    nextFollowup: latest?.phNextFollowup ?? null,
    nextFollowupNote: latest?.phNextFollowupNote ?? null,
    prescriptionUrl: latest?.phPrescriptionUrl ?? null,
  };
}

export function buildAihsContext(rows: HealthFormRow[], hba1c: { value: number | null; date: string | null } = { value: null, date: null }): AihsContext {
  const aihs = rows.filter((r) => trackFromReasonType(r.reason, r.type) === 'aihs');
  const latest = aihs[0] || null;
  return { hba1c: hba1c.value, hba1cDate: hba1c.date, nextFollowup: latest?.ihsNextFollowup ?? null };
}

// ── expectations engine ──────────────────────────────────────────────────────────
export type ExpStatus = 'met' | 'gap' | 'watch' | 'manual';
export interface Expectation { id: string; label: string; status: ExpStatus; detail: string; }

function daysAgo(dateStr: string | null, today: Date): number | null {
  if (!dateStr) return null;
  const t = Date.parse(dateStr + 'T00:00:00Z');
  if (Number.isNaN(t)) return null;
  const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((now - t) / 86400000);
}

export interface TrackContext { fever?: FeverContext; posthosp?: PosthospContext; aihs?: AihsContext; }

export function evaluateExpectations(track: TrackKey, ctx: TrackContext, today: Date = new Date()): Expectation[] {
  if (track === 'fever' && ctx.fever) return feverExpectations(ctx.fever, today);
  if (track === 'posthosp' && ctx.posthosp) return posthospExpectations(ctx.posthosp, today);
  if (track === 'aihs' && ctx.aihs) return aihsExpectations(ctx.aihs, today);
  return [];
}

function feverExpectations(f: FeverContext, today: Date): Expectation[] {
  const out: Expectation[] = [];
  // symptoms captured today (touchpoint within 1 day)
  const ago = daysAgo(f.lastFormDate, today);
  out.push({
    id: 'symptoms_captured', label: 'Symptoms captured recently',
    status: f.recovered ? 'met' : ago == null ? 'gap' : ago <= 1 ? 'met' : 'watch',
    detail: ago == null ? 'No recent fever touchpoint.' : ago <= 1 ? 'Logged within a day.' : `Last touchpoint ${ago} days ago.`,
  });
  // danger-sign screen
  const dangers = f.symptoms.filter((s) => DANGER_SIGNS.some((d) => s.toLowerCase().includes(d)));
  out.push({
    id: 'danger_signs', label: 'Danger-sign screen',
    status: f.recovered ? 'met' : dangers.length ? 'watch' : 'manual',
    detail: dangers.length ? `Reported: ${dangers.join(', ')} — confirm hydration, breathing, bleeding.` : 'Confirm no breathlessness / bleeding / altered senses / poor intake.',
  });
  // fever duration ≥5 not settling  [ASSUMPTION threshold]
  out.push({
    id: 'fever_duration', label: 'Fever duration',
    status: f.recovered ? 'met' : (f.latestDay != null && f.latestDay >= 5) ? 'watch' : 'met',
    detail: f.latestDay == null ? 'Day of fever not recorded.' : f.recovered ? 'Reported recovered.' : `Day ${f.latestDay}${f.latestDay >= 5 ? ' — clinician re-review if not improving.' : '.'}`,
  });
  // platelet / lab watch — not derivable from the form; manual pointer
  out.push({ id: 'platelet_watch', label: 'Platelet / danger-lab watch', status: f.recovered ? 'met' : 'manual', detail: 'If CBC was ordered, confirm platelet trend — the key admit/no-admit datum.' });
  // disposition
  out.push({
    id: 'disposition', label: 'Disposition recorded',
    status: f.dispositionRecorded ? 'met' : 'gap',
    detail: f.dispositionRecorded ? 'Outcome captured.' : 'Decide reassure-and-continue vs escalate-to-hospital.',
  });
  return out;
}

function posthospExpectations(p: PosthospContext, today: Date): Expectation[] {
  const out: Expectation[] = [];
  const total = p.items.length;
  const unbooked = p.items.filter((i) => !i.booked);
  const pendingBooked = p.items.filter((i) => i.booked && !i.completed);
  const completed = p.items.filter((i) => i.completed);
  out.push({
    id: 'all_booked', label: 'All prescribed items booked',
    status: total === 0 ? 'manual' : unbooked.length === 0 ? 'met' : 'gap',
    detail: total === 0 ? 'No prescribed follow-up items on file.' : unbooked.length === 0 ? `${total}/${total} booked.` : `Unbooked (${unbooked.length}): ${unbooked.map((i) => i.name).slice(0, 6).join(', ')}.`,
  });
  out.push({
    id: 'all_completed', label: 'All booked items completed',
    status: total === 0 ? 'manual' : completed.length === total ? 'met' : pendingBooked.length ? 'watch' : 'gap',
    detail: total === 0 ? '—' : `${completed.length}/${total} completed${pendingBooked.length ? `, ${pendingBooked.length} booked & pending` : ''}.`,
  });
  out.push({ id: 'counsel_purpose', label: 'Counsel on purpose', status: 'manual', detail: 'Confirm the member understands why each test/referral was ordered.' });
  const ago = daysAgo(p.nextFollowup ? p.nextFollowup.slice(0, 10) : null, today);
  out.push({
    id: 'next_followup', label: 'Next follow-up',
    status: (p.nextFollowup || p.nextFollowupNote) ? 'met' : (unbooked.length || pendingBooked.length) ? 'watch' : 'met',
    detail: p.nextFollowup ? `Return ${p.nextFollowup.slice(0, 10)}${ago != null && ago > 0 ? ' (overdue)' : ''}.`
      : p.nextFollowupNote ? `No follow-up needed — ${p.nextFollowupNote.trim()}.`
      : 'Set a return date while items are pending.',
  });
  return out;
}

function aihsExpectations(a: AihsContext, today: Date): Expectation[] {
  const out: Expectation[] = [];
  const hbAgo = daysAgo(a.hba1cDate, today);
  const recent = hbAgo != null && hbAgo <= 183; // 6 months  [ASSUMPTION]
  // The HbA1c *value* lives inside the report PDF; from db13 metadata we can see a report EXISTS
  // and its date, not the number. So key off report recency (value shown when available).
  out.push({
    id: 'hba1c_current', label: 'Recent HbA1c on file',
    status: a.hba1cDate == null ? 'gap' : recent ? 'met' : 'watch',
    detail: a.hba1cDate == null ? 'No HbA1c report found — order one.'
      : `HbA1c report ${a.hba1cDate}${a.hba1c != null ? ` (${a.hba1c}%)` : ''}${recent ? '' : ' — overdue'}.`,
  });
  out.push({ id: 'complication_screens', label: 'Complication screens', status: 'manual', detail: 'Retinopathy / nephropathy / foot screens — confirm not overdue (needs specialist-visit data).' });
  out.push({ id: 'adherence', label: 'Medication adherence', status: 'manual', detail: 'Confirm no refill gaps on chronic medication.' });
  out.push({
    id: 'next_followup', label: 'Next follow-up set',
    status: a.nextFollowup ? 'met' : 'watch',
    detail: a.nextFollowup ? `Review ${a.nextFollowup.slice(0, 10)}.` : 'Schedule the next chronic-care review.',
  });
  return out;
}

/** Count of expectations needing attention (gap or watch), for the worklist/summary chips. */
export function openCount(exps: Expectation[]): number {
  return exps.filter((e) => e.status === 'gap' || e.status === 'watch').length;
}
