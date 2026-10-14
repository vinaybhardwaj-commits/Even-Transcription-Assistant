/**
 * src/lib/audit-findings.ts — the governance-side view of routed audit threads (Round 2 / F3).
 *
 * PURE and client-safe: no env, no I/O. CDMSS owns the threads (roster-audits, audit-signal,
 * signal-action); this file turns what it sends into the rows, buckets, plain-word statuses and
 * timeline sentences the governance screens show. Governance staff may see everything CDMSS sends
 * (importance, ruling, ids); the doctor-facing allowlist in doctor-card.ts is a different file and
 * nothing here is ever sent to a physician.
 *
 * ⚠️ NOTHING HERE PRINTS A RAW CODE WITHOUT A FALLBACK. An unknown status, verb, action or event
 * becomes a plain sentence with the code in brackets, never a blank.
 */

export const NOTE_CLASSES = ["opd", "discharge_summary", "ot"] as const;
export type NoteClass = (typeof NOTE_CLASSES)[number];

export const STATUSES = ["routed", "responded", "escalated", "ruled", "closed"] as const;
export type ThreadStatus = (typeof STATUSES)[number];

/** The signal-action vocabulary CDMSS accepts (opd-gov-signal-core SIGNAL_ACTIONS). */
export const SIGNAL_ACTIONS = ["acknowledged_by_governance", "privilege_action", "dismissed", "closed"] as const;
export type SignalAction = (typeof SIGNAL_ACTIONS)[number];

export function isSignalAction(v: unknown): v is SignalAction {
  return typeof v === "string" && (SIGNAL_ACTIONS as readonly string[]).includes(v);
}

export const BUCKETS = ["attention", "overdue", "disagreed", "awaiting_ruling", "awaiting_doctor", "all"] as const;
export type Bucket = (typeof BUCKETS)[number];

export const BUCKET_LABEL: Record<Bucket, string> = {
  attention: "Needs attention",
  overdue: "Overdue",
  disagreed: "Doctor disagreed",
  awaiting_ruling: "Awaiting ruling",
  awaiting_doctor: "Awaiting doctor",
  all: "All threads",
};

// ───────────────────────────── plain words ─────────────────────────────

export const NOTE_CLASS_LABEL: Record<NoteClass, string> = {
  opd: "OPD note",
  discharge_summary: "Discharge summary",
  ot: "OT note",
};

export function noteClassOf(raw: unknown): NoteClass {
  if (raw === "discharge" || raw === "discharge_summary") return "discharge_summary";
  if (raw === "ot") return "ot";
  return "opd";
}

export const ACTION_LABEL: Record<SignalAction, string> = {
  acknowledged_by_governance: "Acknowledged by governance",
  privilege_action: "Privilege review recorded",
  dismissed: "Dismissed as not applicable",
  closed: "Closed",
};

/** What the button says (imperative), with one line on what it does. */
export const ACTION_CHOICE: Record<SignalAction, { button: string; help: string }> = {
  acknowledged_by_governance: {
    button: "Acknowledge",
    help: "Governance has reviewed this and needs nothing further. The thread stays visible to the doctor.",
  },
  privilege_action: {
    button: "Record privilege review",
    help: "Records that governance referred this for a privilege review. It does not change any privilege; do that in the physician's profile.",
  },
  dismissed: {
    button: "Dismiss",
    help: "Not applicable. The thread closes and disappears from the doctor's list.",
  },
  closed: {
    button: "Close",
    help: "Resolved. The thread closes; the doctor's response stays on record.",
  },
};

export function actionLabel(a: unknown): string {
  return isSignalAction(a) ? ACTION_LABEL[a] : typeof a === "string" && a ? `Action recorded (${a})` : "Action recorded";
}

/**
 * Which actions a thread in `status` may take. Mirrors CDMSS signalActionTransition so the screen
 * never offers a button the API would refuse; CDMSS stays the authority (a 409 is still handled).
 */
export function allowedActions(status: string): SignalAction[] {
  if (status === "closed") return [];
  if (status === "ruled") return ["privilege_action", "closed", "dismissed"];
  return [...SIGNAL_ACTIONS];
}

export type ResponseVerb = "agree" | "disagree" | "needs_clarification";

export interface ThreadResponse {
  verb: ResponseVerb | null;
  verb_text: string;
  comment: string | null;
  comment_short: string | null;
  at: string | null;
}

export function shortText(text: string | null | undefined, max = 120): string | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The doctor's verb, from the P2 `verb` or the legacy type/verdict pair. */
export function responseVerbOf(raw: unknown): ResponseVerb | null {
  const o = obj(raw);
  if (!o) return null;
  const verb = o.verb ?? o.verdict;
  if (verb === "agree" || verb === "disagree" || verb === "needs_clarification") return verb;
  if (o.type === "acknowledgment") return "agree";
  return null;
}

export function responseVerbText(verb: ResponseVerb | null, responseRequired?: string | null): string {
  if (verb === "agree") return responseRequired === "acknowledgment" ? "Acknowledged" : "Agreed";
  if (verb === "disagree") return "Disagreed";
  if (verb === "needs_clarification") return "Asked for clarification";
  return "Responded";
}

export function parseResponse(raw: unknown, responseRequired?: string | null): ThreadResponse | null {
  const o = obj(raw);
  if (!o) return null;
  const verb = responseVerbOf(o);
  const comment = str(o.comment);
  return {
    verb,
    verb_text: responseVerbText(verb, responseRequired),
    comment,
    comment_short: shortText(comment),
    at: str(o.responded_at) ?? str(o.at),
  };
}

export interface ThreadRuling {
  action: string | null;
  action_text: string;
  note: string | null;
  actor: string | null;
  gov_intervention_ref: string | null;
  ruled_at: string | null;
}

export function parseRuling(raw: unknown): ThreadRuling | null {
  const o = obj(raw);
  if (!o) return null;
  return {
    action: str(o.action),
    action_text: actionLabel(o.action),
    note: str(o.note),
    actor: str(o.actor),
    gov_intervention_ref: str(o.gov_intervention_ref),
    ruled_at: str(o.ruled_at),
  };
}

const RESPONSE_REQUIRED_TEXT: Record<string, string> = {
  none: "No response needed",
  acknowledgment: "Acknowledgment needed",
  explanation: "Explanation needed",
  recommend_privilege_review: "Privilege review recommended",
};

export function responseRequiredText(v: string | null | undefined): string {
  if (!v) return "—";
  return RESPONSE_REQUIRED_TEXT[v] ?? v.replace(/_/g, " ");
}

/** The thread's status in words, as a governance reader would say it. */
export function statusText(t: {
  status: string;
  response_required: string;
  response: ThreadResponse | null;
  ruling: ThreadRuling | null;
}): string {
  switch (t.status) {
    case "routed":
      return t.response_required === "none" ? "Shared with doctor, no response needed" : "Awaiting the doctor's response";
    case "responded":
      return "Doctor responded";
    case "escalated":
      if (t.response?.verb === "disagree") return "Doctor disagreed, awaiting ruling";
      if (t.response?.verb === "needs_clarification") return "Doctor asked for clarification, awaiting ruling";
      if (t.response_required === "recommend_privilege_review") return "Privilege review recommended, awaiting ruling";
      return "Escalated, awaiting ruling";
    case "ruled":
      return t.ruling?.action ? `Ruled: ${t.ruling.action_text}` : "Ruled";
    case "closed":
      if (t.ruling?.action === "dismissed") return "Dismissed";
      if (t.ruling?.action) return `Closed: ${t.ruling.action_text}`;
      return "Closed (withdrawn by the care manager)";
    default:
      return t.status ? `Status: ${t.status}` : "Status unknown";
  }
}

// ───────────────────────────── rows ─────────────────────────────

export interface FindingRow {
  reference: string;
  signal_id: string;
  doctor_uid: string;
  doctor_name: string | null;
  physician_id: string | null;
  finding_type: string;
  signal_type: string;
  note_class: NoteClass;
  note_type: string;
  routed_at: string | null;
  status: string;
  status_text: string;
  importance: string | null;
  response_required: string;
  response_required_text: string;
  overdue: boolean;
  sla_due_at: string | null;
  instances: number | null;
  window: { from: string | null; to: string | null };
  response: ThreadResponse | null;
  ruling: ThreadRuling | null;
  disagreed: boolean;
  awaiting_ruling: boolean;
  needs_attention: boolean;
  attention_reasons: string[];
  /**
   * Set by the worklist route when the doctor's answer to this thread is not in CDMSS yet (the
   * forward failed or is still waiting for its retry). Absent when the answer is synced or none was given.
   */
  sync?: SyncFlag | null;
  /**
   * Set by the worklist route when a governance ruling on this thread is saved here but CDMSS has not
   * confirmed it. It is never shown as a done ruling.
   */
  pending_ruling?: PendingRulingFlag | null;
}

/** A ruling recorded in EPI that CDMSS has not confirmed yet. */
export interface PendingRulingFlag {
  action: string;
  attempts: number;
  since: string | null;
}

/** The forward of a doctor's answer to CDMSS has not completed. */
export interface SyncFlag {
  state: "pending" | "failed";
  /** CDMSS refused the answer; retries stop and someone has to look at it. */
  permanent: boolean;
  attempts: number;
}

export interface RawSignal {
  reference?: unknown;
  signal_id?: unknown;
  doctor_uid?: unknown;
  signal_type?: unknown;
  note_class?: unknown;
  label?: unknown;
  importance?: unknown;
  response_required?: unknown;
  status?: unknown;
  overdue?: unknown;
  instances?: unknown;
  window?: unknown;
  routed_at?: unknown;
  sla_due_at?: unknown;
  response?: unknown;
  ruling?: unknown;
  representative?: unknown;
}

/** Fallback title when CDMSS sends no label: "dose_ceiling_exceeded" -> "Dose ceiling exceeded". */
export function findingTypeText(label: unknown, signalType: unknown): string {
  const l = str(label);
  if (l) return l;
  const t = str(signalType);
  if (!t) return "Finding";
  const words = t.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface DoctorLookup {
  /** CDMSS doctor uid (canonical or alias) -> local physician. */
  byUid: ReadonlyMap<string, { physician_id: string; full_name: string }>;
  /** CDMSS doctor uid -> name CDMSS sent on the roster. */
  cdmssNames?: ReadonlyMap<string, string>;
}

/** PURE. One CDMSS signal object -> a worklist row; null when it is not a thread at all. */
export function toFindingRow(raw: unknown, lookup?: DoctorLookup): FindingRow | null {
  const s = obj(raw) as RawSignal | null;
  if (!s) return null;
  const reference = str(s.reference);
  const doctorUid = str(s.doctor_uid);
  if (!reference || !doctorUid) return null;
  const status = str(s.status) ?? "routed";
  const responseRequired = str(s.response_required) ?? "none";
  const response = parseResponse(s.response, responseRequired);
  const ruling = parseRuling(s.ruling);
  const noteClass = noteClassOf(s.note_class);
  const local = lookup?.byUid.get(doctorUid) ?? null;
  const overdue = s.overdue === true;
  const awaiting = status === "escalated";
  const open = status !== "ruled" && status !== "closed";
  const disagreed = open && response?.verb === "disagree";
  const reasons: string[] = [];
  if (overdue) reasons.push("Overdue");
  if (disagreed) reasons.push("Doctor disagreed");
  if (awaiting) {
    reasons.push(responseRequired === "recommend_privilege_review" && !response ? "Privilege review awaiting ruling" : "Awaiting ruling");
  }
  const win = obj(s.window);
  return {
    reference,
    signal_id: str(s.signal_id) ?? "",
    doctor_uid: doctorUid,
    doctor_name: local?.full_name ?? lookup?.cdmssNames?.get(doctorUid) ?? null,
    physician_id: local?.physician_id ?? null,
    finding_type: findingTypeText(s.label, s.signal_type),
    signal_type: str(s.signal_type) ?? "",
    note_class: noteClass,
    note_type: NOTE_CLASS_LABEL[noteClass],
    routed_at: str(s.routed_at),
    status,
    status_text: statusText({ status, response_required: responseRequired, response, ruling }),
    importance: str(s.importance),
    response_required: responseRequired,
    response_required_text: responseRequiredText(responseRequired),
    overdue,
    sla_due_at: str(s.sla_due_at),
    instances: typeof s.instances === "number" ? s.instances : null,
    window: { from: str(win?.from), to: str(win?.to) },
    response,
    ruling,
    disagreed,
    awaiting_ruling: awaiting,
    needs_attention: overdue || disagreed || awaiting,
    attention_reasons: reasons,
  };
}

/**
 * PURE. Every thread in a roster-audits body: `doctors[].signals[]`, with the CDMSS doctor name and
 * the local physician filled in. The same thread under two doctors entries is kept once.
 */
export function rowsFromRoster(body: unknown, lookup?: DoctorLookup): FindingRow[] {
  const root = obj(body);
  const doctors = Array.isArray(root?.doctors) ? (root!.doctors as unknown[]) : [];
  const names = new Map<string, string>(lookup?.cdmssNames ? Array.from(lookup.cdmssNames.entries()) : []);
  for (const d of doctors) {
    const o = obj(d);
    const uid = str(o?.doctor_uid);
    const name = str(o?.name);
    if (uid && name && !names.has(uid)) names.set(uid, name);
  }
  const merged: DoctorLookup = { byUid: lookup?.byUid ?? new Map(), cdmssNames: names };
  const out: FindingRow[] = [];
  const seen = new Set<string>();
  for (const d of doctors) {
    const sigs = obj(d) && Array.isArray((d as { signals?: unknown }).signals) ? ((d as { signals: unknown[] }).signals) : [];
    for (const raw of sigs) {
      const row = toFindingRow(raw, merged);
      if (!row || seen.has(row.reference)) continue;
      seen.add(row.reference);
      out.push(row);
    }
  }
  return out;
}

// ───────────────────────────── buckets, filters, sort ─────────────────────────────

export interface BucketCounts {
  attention: number;
  overdue: number;
  disagreed: number;
  awaiting_ruling: number;
  awaiting_doctor: number;
  all: number;
}

export function isAwaitingDoctor(r: FindingRow): boolean {
  return r.status === "routed" && r.response_required !== "none";
}

/** PURE. Plain-words hover text for the "Not yet synced" badge. */
export function syncFlagText(flag: SyncFlag): string {
  if (flag.permanent) return "CDMSS refused the doctor's answer, so it will not be retried. Governance needs to look at it.";
  if (flag.state === "failed") {
    return `The doctor's answer has not reached CDMSS yet (${flag.attempts} ${flag.attempts === 1 ? "attempt" : "attempts"} so far). It is retried every night.`;
  }
  return "The doctor's answer is waiting to be sent to CDMSS.";
}

/** PURE. Rows with their sync flag attached, matched by thread reference. Rows with no flag are left untouched. */
export function annotateSync(rows: readonly FindingRow[], flags: ReadonlyMap<string, SyncFlag>): FindingRow[] {
  return rows.map((r) => {
    const f = flags.get(r.reference);
    return f ? { ...r, sync: f } : r;
  });
}

/** PURE. Plain-words hover text for the "Pending sync" ruling badge. */
export function pendingRulingText(flag: PendingRulingFlag): string {
  const what = isSignalAction(flag.action) ? actionLabel(flag.action) : "A ruling";
  return `${what} is saved here but CDMSS has not confirmed it yet, so the thread still shows its old status there. It is retried every night; opening the thread and pressing the same button retries it now.`;
}

/** PURE. Rows with their unconfirmed ruling attached, matched by thread reference. */
export function annotatePendingRulings(rows: readonly FindingRow[], pending: ReadonlyMap<string, PendingRulingFlag>): FindingRow[] {
  return rows.map((r) => {
    const f = pending.get(r.reference);
    return f ? { ...r, pending_ruling: f } : r;
  });
}

/** PURE. Threads whose doctor answer has not reached CDMSS (and how many failed), and threads with an unconfirmed ruling. */
export function countNotSynced(rows: readonly FindingRow[]): { not_synced: number; failed: number; rulings_pending: number } {
  let notSynced = 0;
  let failed = 0;
  let rulingsPending = 0;
  for (const r of rows) {
    if (r.pending_ruling) rulingsPending += 1;
    if (!r.sync) continue;
    notSynced += 1;
    if (r.sync.state === "failed") failed += 1;
  }
  return { not_synced: notSynced, failed, rulings_pending: rulingsPending };
}

/** PURE. Counts per bucket over the rows given (the unfiltered set, so the tiles never lie). */
export function countBuckets(rows: readonly FindingRow[]): BucketCounts {
  const c: BucketCounts = { attention: 0, overdue: 0, disagreed: 0, awaiting_ruling: 0, awaiting_doctor: 0, all: rows.length };
  for (const r of rows) {
    if (r.needs_attention) c.attention += 1;
    if (r.overdue) c.overdue += 1;
    if (r.disagreed) c.disagreed += 1;
    if (r.awaiting_ruling) c.awaiting_ruling += 1;
    if (isAwaitingDoctor(r)) c.awaiting_doctor += 1;
  }
  return c;
}

export function inBucket(r: FindingRow, bucket: Bucket): boolean {
  switch (bucket) {
    case "attention":
      return r.needs_attention;
    case "overdue":
      return r.overdue;
    case "disagreed":
      return r.disagreed;
    case "awaiting_ruling":
      return r.awaiting_ruling;
    case "awaiting_doctor":
      return isAwaitingDoctor(r);
    default:
      return true;
  }
}

export interface FindingFilters {
  view?: Bucket;
  status?: string;
  importance?: string;
  response_required?: string;
  note_class?: string;
  doctor_uid?: string;
  /** YYYY-MM-DD, compared with the routed date (inclusive). */
  from?: string;
  to?: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isBucket(v: unknown): v is Bucket {
  return typeof v === "string" && (BUCKETS as readonly string[]).includes(v);
}

/** PURE. Query string -> filters; unknown values are dropped, never passed through. */
export function parseFilters(params: URLSearchParams): FindingFilters {
  const f: FindingFilters = {};
  const get = (k: string) => (params.get(k) ?? "").trim();
  const view = get("view");
  f.view = isBucket(view) ? view : "attention";
  const status = get("status");
  if ((STATUSES as readonly string[]).includes(status)) f.status = status;
  const importance = get("importance");
  if (/^[a-z_]{1,32}$/i.test(importance)) f.importance = importance;
  const rr = get("response_required");
  if (/^[a-z_]{1,40}$/i.test(rr)) f.response_required = rr;
  const nc = get("note_class");
  if (nc) f.note_class = noteClassOf(nc);
  const uid = get("doctor_uid");
  if (uid && uid.length <= 128) f.doctor_uid = uid;
  const from = get("from");
  if (DAY_RE.test(from)) f.from = from;
  const to = get("to");
  if (DAY_RE.test(to)) f.to = to;
  return f;
}

export function applyFilters(rows: readonly FindingRow[], f: FindingFilters): FindingRow[] {
  return rows.filter((r) => {
    if (f.view && !inBucket(r, f.view)) return false;
    if (f.status && r.status !== f.status) return false;
    if (f.importance && (r.importance ?? "").toLowerCase() !== f.importance.toLowerCase()) return false;
    if (f.response_required && r.response_required !== f.response_required) return false;
    if (f.note_class && r.note_class !== f.note_class) return false;
    if (f.doctor_uid && r.doctor_uid !== f.doctor_uid) return false;
    const day = (r.routed_at ?? "").slice(0, 10);
    if (f.from && (!day || day < f.from)) return false;
    if (f.to && (!day || day > f.to)) return false;
    return true;
  });
}

function attentionRank(r: FindingRow): number {
  // Lower sorts first: awaiting a ruling, then a disagreement, then overdue, then the rest.
  if (r.awaiting_ruling) return 0;
  if (r.disagreed) return 1;
  if (r.overdue) return 2;
  return 3;
}

/** Most urgent first; within the same urgency the oldest routed date first. */
export function sortRows(rows: readonly FindingRow[]): FindingRow[] {
  return [...rows].sort((a, b) => {
    const d = attentionRank(a) - attentionRank(b);
    if (d !== 0) return d;
    const at = a.routed_at ?? "";
    const bt = b.routed_at ?? "";
    if (at !== bt) return at < bt ? -1 : 1;
    return a.reference.localeCompare(b.reference);
  });
}

// ───────────────────────────── thread detail ─────────────────────────────

export interface Instance {
  audit_id: string | null;
  finding_ref: string | null;
  subject: string | null;
  verdict: string | null;
  rationale: string | null;
  note_date: string | null;
  citations: Array<{ n: number | null; title: string; url: string | null }>;
}

export function parseInstance(raw: unknown): Instance | null {
  const o = obj(raw);
  if (!o) return null;
  const cites = Array.isArray(o.citations) ? o.citations : [];
  return {
    audit_id: str(o.audit_id),
    finding_ref: str(o.finding_ref),
    subject: str(o.subject),
    verdict: str(o.verdict),
    rationale: str(o.rationale),
    note_date: str(o.note_date),
    citations: cites
      .map((c) => obj(c))
      .filter((c): c is Record<string, unknown> => !!c)
      .map((c) => ({ n: typeof c.n === "number" ? c.n : null, title: str(c.title) ?? "Source", url: str(c.url) }))
      .slice(0, 12),
  };
}

export interface TimelineEntry {
  at: string | null;
  actor: string;
  event: string;
  text: string;
  note: string | null;
}

/** "cm:asha" -> "Care manager asha"; "doctor:U1" -> the doctor; "gov:a@even.in" -> "a@even.in". */
export function actorText(actor: string | null | undefined, doctorName?: string | null): string {
  const a = (actor ?? "").trim();
  if (!a) return "System";
  if (a.startsWith("cm:")) return `Care manager ${a.slice(3)}`.trim();
  if (a.startsWith("doctor:")) return doctorName ? `Dr ${doctorName.replace(/^dr\.?\s+/i, "")}` : "The doctor";
  if (a.startsWith("gov:")) return a.slice(4) || "Governance";
  return a;
}

function eventSentence(event: string, p: Record<string, unknown> | null): { text: string; note: string | null } {
  const note = str(p?.note) ?? str(p?.comment);
  switch (event) {
    case "routed": {
      const rr = str(p?.response_required);
      const imp = str(p?.importance);
      const bits = [imp ? `importance ${imp}` : null, rr ? responseRequiredText(rr).toLowerCase() : null].filter(Boolean);
      const lead = p?.re_routed === true ? "Re-routed to the doctor" : "Routed to the doctor";
      return { text: bits.length ? `${lead} (${bits.join(", ")})` : lead, note: null };
    }
    case "escalated": {
      const reason = str(p?.reason);
      if (reason === "doctor disagreed") return { text: "Escalated for a ruling because the doctor disagreed", note: null };
      if (reason === "doctor needs clarification") return { text: "Escalated for a ruling because the doctor asked for clarification", note: null };
      if (str(p?.response_required) === "recommend_privilege_review") {
        return { text: "Escalated: privilege review recommended", note: null };
      }
      return { text: reason ? `Escalated for a ruling (${reason})` : "Escalated for a ruling", note: null };
    }
    case "responded": {
      const verb = responseVerbOf(p);
      const t = verb === "agree" ? (p?.type === "acknowledgment" ? "acknowledged" : "agreed") : verb === "disagree" ? "disagreed" : verb === "needs_clarification" ? "asked for clarification" : "responded";
      return { text: `The doctor ${t}`, note };
    }
    case "ruled":
      return { text: `Ruled: ${actionLabel(p?.action)}`, note };
    case "closed": {
      if (p?.action) return { text: `Closed by governance: ${actionLabel(p.action)}`, note };
      const reason = str(p?.reason);
      return { text: reason ? `Closed (${reason})` : "Closed", note };
    }
    default:
      return { text: `Event: ${event}`, note };
  }
}

/** PURE. The append-only CDMSS event log -> a timeline in plain words, oldest first. */
export function describeEvents(events: unknown, doctorName?: string | null): TimelineEntry[] {
  const list = Array.isArray(events) ? events : [];
  const out: TimelineEntry[] = [];
  for (const raw of list) {
    const o = obj(raw);
    if (!o) continue;
    const event = str(o.event) ?? "event";
    const payload = obj(o.payload);
    const s = eventSentence(event, payload);
    out.push({
      at: str(o.at),
      actor: actorText(str(o.actor), doctorName),
      event,
      text: s.text,
      note: s.note,
    });
  }
  return out.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
}
