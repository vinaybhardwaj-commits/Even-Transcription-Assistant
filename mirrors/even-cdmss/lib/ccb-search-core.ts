/**
 * lib/ccb-search-core.ts — Care Conversation Brief: MEMBER SEARCH core (pure).
 *
 * PURE, dependency-free (node --experimental-strip-types friendly). Turns a care manager's
 * free-text query (member ID, phone, name, individual UID, or UHID — "same as Pulse search")
 * into a set of validated db13 lookups, and shapes the resulting rows into member hits.
 *
 * WHY THIS EXISTS: before this, the /care surface only accepted an internal prescription uid,
 * so a Member ID / individual UID / phone / name all 404'd (the string was looked up in
 * `individuals-prescriptions.uid`). This core builds the member-level resolution the care team
 * actually needs. The wired orchestration + Metabase reads live in ccb-search.ts.
 *
 * DATA SPINE (verified live in db13, 1 Jul):
 *   • member ID  → `accounts-members`.membership_id / old_membership_ids → .mobile
 *                  → `individuals`.mobiles (array overlap)            (Member 000000000000 → Example Person)
 *   • phone      → `individuals`.mobiles && ARRAY['+91…']
 *   • individual → `individuals`.uid   (the id Pulse calls "uid": 00000000000000000000)
 *   • uhid       → `individuals`.kx_uhid  (UHID000001)
 *   • presc uid  → `individuals-prescriptions`.uid → ._parent_id (back-compat with old links)
 *   • name       → `individuals`.first_name / last_name / display_name
 *   • episodes   → `individuals-prescriptions` WHERE _parent_id = individual_uid, medical types.
 *
 * SECURITY: search input is USER-SUPPLIED, so every interpolated value is validated or escaped
 * BEFORE it reaches SQL (mirrors lib/metabase.ts). Names are stripped to a safe charset (no LIKE
 * metacharacters survive), ids/dates/phones are regex-gated, and every builder rejects junk.
 */

// ── Validators / normalizers (inline; keep this module dependency-free) ─────────
export const isUid = (u: string): boolean => /^[A-Za-z0-9_-]{6,64}$/.test(u);
export const isUhidLike = (u: string): boolean => /^[A-Za-z0-9][A-Za-z0-9/_-]{2,39}$/.test(u);
export const isPresType = (t: string): boolean => /^[A-Z][A-Z_]{2,59}$/.test(t);
/** A stored consumer mobile: E.164-ish, e.g. +910000000000. */
export const isMobile = (m: string): boolean => /^\+\d{10,15}$/.test(m);

const digitsOf = (s: string): string => (s || '').replace(/\D+/g, '');

/** Normalize a typed phone to the stored `+91XXXXXXXXXX` shape. Null if it can't be a 10-digit
 *  Indian mobile. Takes the last 10 digits so +91 / 0 / spacing variants all collapse. */
export function normPhone(s: string): string | null {
  const d = digitsOf(s);
  if (d.length < 10) return null;
  const last10 = d.slice(-10);
  if (!/^[6-9]\d{9}$/.test(last10)) return null; // Indian mobiles start 6–9
  return `+91${last10}`;
}

/** Escape a plain string literal for single-quote-delimited SQL (''-escaping), length-capped. */
export function sqlStr(s: string, max = 64): string {
  return String(s ?? '').slice(0, max).replace(/'/g, "''");
}

/** Reduce a name token to a safe charset (letters, space, . ' -) so NO LIKE metacharacter or
 *  quote survives; then ''-escape the apostrophe. Returns '' if nothing usable remains. */
export function sanitizeNameToken(t: string): string {
  const cleaned = String(t ?? '').replace(/[^A-Za-zÀ-ɏ .'-]+/g, ' ').trim().slice(0, 30);
  return cleaned.replace(/'/g, "''");
}

// ── Query classification ────────────────────────────────────────────────────────
export interface QueryPlan {
  trimmed: string;
  phone: string | null;      // normalized +91… (phone probe)
  memberId: string | null;   // digit string (accounts-members probe)
  uid: string | null;        // token for individuals.uid / prescriptions.uid exact probe
  uhid: string | null;       // token for individuals.kx_uhid exact probe
  nameTokens: string[] | null; // 1–3 sanitized tokens (name ILIKE probe)
}

export function planHasProbe(p: QueryPlan): boolean {
  return !!(p.phone || p.memberId || p.uid || p.uhid || (p.nameTokens && p.nameTokens.length));
}

/**
 * Classify a free-text query into the set of lookups to run. Ambiguous inputs deliberately fan
 * out to multiple probes (e.g. a numeric string probes BOTH member-id and phone) — the extra
 * exact-match lookups are cheap and the union disambiguates, so the CM never has to pick a mode.
 */
export function classifyQuery(raw: string): QueryPlan {
  const trimmed = String(raw ?? '').trim();
  const plan: QueryPlan = { trimmed, phone: null, memberId: null, uid: null, uhid: null, nameTokens: null };
  if (trimmed.length < 2) return plan;

  const digits = digitsOf(trimmed);
  const hasSpace = /\s/.test(trimmed);
  const alnumTokenRe = /^[A-Za-z0-9_-]{6,64}$/;

  // Phone: any input carrying a valid 10-digit Indian mobile.
  plan.phone = normPhone(trimmed);

  // Member ID: an all-digits token (allowing spaces), 6–18 digits.
  if (/^[\d\s]+$/.test(trimmed) && digits.length >= 6 && digits.length <= 18) plan.memberId = digits;

  // Individual / prescription UID: an id-shaped token that isn't a plain word — must contain a
  // digit or be long (Firestore doc ids are 20 mixed-case chars) and hold at least one letter.
  if (!hasSpace && alnumTokenRe.test(trimmed) && /[A-Za-z]/.test(trimmed) && (/\d/.test(trimmed) || trimmed.length >= 12)) {
    plan.uid = trimmed;
  }

  // UHID: a code with a separator or letters-then-digits (UHID000001, UHID000002).
  if (!hasSpace && isUhidLike(trimmed) && /\d/.test(trimmed)
      && (/[-/]/.test(trimmed) || /^[A-Za-z]{2,10}\d{2,}$/.test(trimmed))) {
    plan.uhid = trimmed;
  }

  // Name: a phrase with a space, or a plain alphabetic word (>=2 letters, no digits).
  if (hasSpace || /^[A-Za-zÀ-ɏ .'-]{2,}$/.test(trimmed)) {
    const toks = trimmed.split(/\s+/).map(sanitizeNameToken).filter((t) => t.replace(/[^A-Za-zÀ-ɏ]/g, '').length >= 2).slice(0, 3);
    if (toks.length) plan.nameTokens = toks;
  }

  return plan;
}

// ── SQL builders (pure; every value validated/escaped before interpolation) ─────
/** Shared identity projection for `individuals` (aliased `i`). */
export const INDIVIDUAL_COLS = 'i.uid, i.first_name, i.last_name, i.display_name, i.gender, i.dob, i.kx_uhid, i.mobiles';

/** accounts-members row(s) for a member ID (current or historical). Returns mobile + name + dob. */
export function membersByMemberIdSql(memberId: string): string {
  const d = digitsOf(memberId);
  if (d.length < 6 || d.length > 18) throw new Error('bad member id');
  return `SELECT membership_id, mobile, first_name, last_name, dob FROM "accounts-members"`
    + ` WHERE membership_id = '${d}' OR '${d}' = ANY(old_membership_ids) LIMIT 10`;
}

/** individuals whose mobiles array overlaps any of the given stored numbers. */
export function individualsByMobilesSql(mobiles: string[]): string {
  const ok = Array.from(new Set((mobiles || []).filter(isMobile)));
  if (!ok.length) throw new Error('no valid mobile');
  const arr = ok.map((m) => `'${m}'`).join(', ');
  return `SELECT ${INDIVIDUAL_COLS} FROM individuals i WHERE i.mobiles && ARRAY[${arr}]::text[] LIMIT 20`;
}

/** individuals by exact consumer UID. */
export function individualByUidSql(uid: string): string {
  if (!isUid(uid)) throw new Error('bad uid');
  return `SELECT ${INDIVIDUAL_COLS} FROM individuals i WHERE i.uid = '${uid}' LIMIT 5`;
}

/** individuals for a set of consumer UIDs (batch identity — e.g. labelling the flagged worklist). */
export function individualsByUidsSql(uids: string[]): string {
  const ok = Array.from(new Set((uids || []).filter(isUid)));
  if (!ok.length) throw new Error('no valid uid');
  const inList = ok.map((u) => `'${u}'`).join(', ');
  return `SELECT ${INDIVIDUAL_COLS} FROM individuals i WHERE i.uid IN (${inList}) LIMIT 100`;
}

/** individuals by exact UHID. */
export function individualsByUhidSql(uhid: string): string {
  if (!isUhidLike(uhid)) throw new Error('bad uhid');
  return `SELECT ${INDIVIDUAL_COLS} FROM individuals i WHERE i.kx_uhid = '${sqlStr(uhid, 40)}' LIMIT 20`;
}

/** prescription uid → its owning individual (back-compat: old links carried a presc uid). */
export function individualUidByPrescSql(prescUid: string): string {
  if (!isUid(prescUid)) throw new Error('bad presc uid');
  return `SELECT _parent_id AS individual_uid FROM "individuals-prescriptions" WHERE uid = '${prescUid}' LIMIT 5`;
}

/** individuals by name tokens (prefix on first/last, contains on display_name). */
export function individualsByNameSql(tokens: string[]): string {
  const toks = (tokens || []).map((t) => sanitizeNameToken(t)).filter((t) => t.replace(/[^A-Za-zÀ-ɏ]/g, '').length >= 2).slice(0, 3);
  if (!toks.length) throw new Error('no valid name token');
  let pred: string;
  if (toks.length === 1) {
    const t = toks[0];
    pred = `(i.first_name ILIKE '${t}%' OR i.last_name ILIKE '${t}%' OR i.display_name ILIKE '%${t}%')`;
  } else {
    const [a, b] = toks;
    pred = `((i.first_name ILIKE '${a}%' AND i.last_name ILIKE '${b}%')`
      + ` OR (i.first_name ILIKE '${b}%' AND i.last_name ILIKE '${a}%')`
      + ` OR i.display_name ILIKE '%${a} ${b}%')`;
  }
  return `SELECT ${INDIVIDUAL_COLS} FROM individuals i WHERE ${pred} LIMIT 20`;
}

/** membership_id for a set of stored mobiles (to label hits with their Member ID). */
export function membershipByMobilesSql(mobiles: string[]): string {
  const ok = Array.from(new Set((mobiles || []).filter(isMobile)));
  if (!ok.length) throw new Error('no valid mobile');
  const arr = ok.map((m) => `'${m}'`).join(', ');
  return `SELECT membership_id, mobile FROM "accounts-members" WHERE mobile IN (${arr}) LIMIT 50`;
}

/** Recent medical OPD episodes for a set of individual uids (latest first). */
export function episodesByParentsSql(individualUids: string[], medicalTypes: string[], perMemberCap = 200): string {
  const uids = Array.from(new Set((individualUids || []).filter(isUid)));
  if (!uids.length) throw new Error('no valid individual uid');
  const types = (medicalTypes || []).filter(isPresType);
  if (!types.length) throw new Error('no valid types');
  const inUids = uids.map((u) => `'${u}'`).join(', ');
  const inTypes = types.map((t) => `'${t}'`).join(', ');
  const cap = Math.max(1, Math.min(500, Math.floor(perMemberCap)));
  return `SELECT uid, _parent_id AS individual_uid, type_of_prescription,`
    + ` to_char(timestamp AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS visit_date, timestamp`
    + ` FROM "individuals-prescriptions"`
    + ` WHERE _parent_id IN (${inUids}) AND is_draft = false AND type_of_prescription IN (${inTypes})`
    + ` ORDER BY timestamp DESC LIMIT ${cap}`;
}

/** Latest medical OPD episode uid for one member (dateless — the CM's default "open latest"). */
export function latestEpisodeSql(individualUid: string, medicalTypes: string[]): string {
  return episodesByParentsSql([individualUid], medicalTypes, 20);
}

// ── Row mappers + hit shaping ───────────────────────────────────────────────────
export interface IndividualIdentity {
  uid: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  gender: string | null;
  dob: string | null;
  uhid: string | null;
  mobiles: string[];
}

export interface EpisodeLite { uid: string; type: string; date: string | null; }

export interface MemberHit {
  individualUid: string;
  name: string;
  gender: string | null;
  age: number | null;
  mobile: string | null;
  uhid: string | null;
  membershipId: string | null;
  episodeCount: number;
  lastVisit: string | null;
  latestEpisodeUid: string | null;
  recentEpisodes: EpisodeLite[];
}

const asStr = (v: unknown): string | null => (v == null ? null : String(v));
const asArr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

export function fullName(first: string | null, last: string | null, display: string | null): string {
  const dn = (display || '').trim();
  if (dn) return dn;
  const nm = [first, last].map((x) => (x || '').trim()).filter(Boolean).join(' ');
  return nm || 'Unknown member';
}

/** Age in whole years from a YYYY-MM-DD(‑ish) dob. Null if unparseable/implausible. */
export function computeAge(dob: string | null, now: Date = new Date()): number | null {
  if (!dob) return null;
  const m = String(dob).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  let age = now.getUTCFullYear() - y;
  const bdayPassed = (now.getUTCMonth() + 1 > mo) || (now.getUTCMonth() + 1 === mo && now.getUTCDate() >= d);
  if (!bdayPassed) age -= 1;
  return age >= 0 && age <= 120 ? age : null;
}

export function mapIndividualRow(r: Record<string, unknown>): IndividualIdentity | null {
  const uid = asStr(r.uid);
  if (!uid || !isUid(uid)) return null;
  return {
    uid,
    firstName: asStr(r.first_name),
    lastName: asStr(r.last_name),
    displayName: asStr(r.display_name),
    gender: asStr(r.gender),
    dob: asStr(r.dob),
    uhid: asStr(r.kx_uhid),
    mobiles: asArr(r.mobiles),
  };
}

/** Assemble ranked member hits from identity rows + episode rows (+ optional member-id map).
 *  Members with episodes rank first, then by most-recent visit. Pure. */
export function buildHits(
  identities: IndividualIdentity[],
  episodeRows: Record<string, unknown>[],
  membershipByMobile: Record<string, string> = {},
  opts: { recent?: number; limit?: number; now?: Date } = {},
): MemberHit[] {
  const recentN = opts.recent ?? 3;
  const limit = opts.limit ?? 12;

  // Group episodes by individual, preserving the query's latest-first order.
  const byMember = new Map<string, EpisodeLite[]>();
  for (const e of episodeRows) {
    const iuid = asStr(e.individual_uid); const uid = asStr(e.uid);
    if (!iuid || !uid) continue;
    const list = byMember.get(iuid) ?? [];
    list.push({ uid, type: asStr(e.type_of_prescription) || '', date: asStr(e.visit_date) });
    byMember.set(iuid, list);
  }

  // Dedupe identities by uid (union of probes may repeat a member).
  const seen = new Map<string, IndividualIdentity>();
  for (const id of identities) if (id && !seen.has(id.uid)) seen.set(id.uid, id);

  const hits: MemberHit[] = [];
  for (const id of seen.values()) {
    const eps = byMember.get(id.uid) ?? [];
    const primaryMobile = id.mobiles[0] ?? null;
    let membershipId: string | null = null;
    for (const m of id.mobiles) if (membershipByMobile[m]) { membershipId = membershipByMobile[m]; break; }
    hits.push({
      individualUid: id.uid,
      name: fullName(id.firstName, id.lastName, id.displayName),
      gender: id.gender,
      age: computeAge(id.dob, opts.now),
      mobile: primaryMobile,
      uhid: id.uhid,
      membershipId,
      episodeCount: eps.length,
      lastVisit: eps[0]?.date ?? null,
      latestEpisodeUid: eps[0]?.uid ?? null,
      recentEpisodes: eps.slice(0, recentN),
    });
  }

  hits.sort((a, b) => {
    if ((b.episodeCount > 0 ? 1 : 0) !== (a.episodeCount > 0 ? 1 : 0)) return (b.episodeCount > 0 ? 1 : 0) - (a.episodeCount > 0 ? 1 : 0);
    return (b.lastVisit || '').localeCompare(a.lastVisit || '');
  });
  return hits.slice(0, limit);
}
