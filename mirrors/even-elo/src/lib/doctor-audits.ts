/**
 * src/lib/doctor-audits.ts — the CDMSS per-doctor findings fetcher.
 *
 * ⚠️ THE READ PATH IS READ-ONLY. This module fetches; it writes nothing. The two write paths live in
 * src/lib/findings-actions.ts (private reactions use PORTAL_REACTIONS; workflow responses use the
 * independent PORTAL_FINDINGS_RESPOND flag).
 *
 * ⚠️ NOTHING HERE SHAPES WHAT A PHYSICIAN SEES. The upstream payload is typed below so the fetcher
 * is honest about what it receives, but the browser-facing shape is built in src/lib/doctor-card.ts
 * by ALLOWLIST: `triage`, `ruling`, `reference`, `doctor_uid`, `overdue`, `sla_due_at` and the
 * envelope's `metrics` are simply never read there. The upstream fields are `unknown` on purpose,
 * so a later edit cannot start rendering one without a type error pointing at this comment.
 *
 * ⚠️ STANDING PORTAL CONTRACT: `physicians.cdmss_doctor_uid` is NEVER exposed by a portal API. The
 * reaction and response endpoints look it up server-side per request and never read it from, nor
 * return it to, the client.
 *
 * CONTRACT FIELDS (all optional, CDMSS adds them in parallel): per finding `routed`, `note_class`,
 * `note_date`, `evidence_excerpt`, `citations`, `patient{name,age,sex,ip_number,uhid}`. They are read
 * from the representative first, then from the signal. Absent means nothing is rendered.
 *
 * Fetch idioms (x-api-key, GOV_API_BASE default, cache:'no-store', the 8s abort) are the ones
 * src/lib/gov-signals.ts already uses. That file is NOT modified and NOT imported.
 */

const BASE = process.env.GOV_API_BASE || "https://even-cdmss.vercel.app";

/** Canonical note class from Even-CDMSS. Older payloads omit it — treat as OPD. */
export type NoteClass = "opd" | "discharge_summary" | "ot";

export const NOTE_CLASSES: readonly NoteClass[] = ["opd", "discharge_summary", "ot"];

/** PURE. Unknown / missing → `opd` so a mixed inbox stays scannable for older signals.
 *  CDMSS's newer spelling `discharge` is accepted as `discharge_summary`. */
export function normalizeNoteClass(raw: unknown): NoteClass {
  if (raw === "opd" || raw === "discharge_summary" || raw === "ot") return raw;
  if (raw === "discharge") return "discharge_summary";
  return "opd";
}

/**
 * PURE. Query string → filter value for the CDMSS call.
 * `all` / empty / invalid → null (omit the param so upstream returns the mixed inbox).
 */
export function parseNoteClassQuery(raw: string | null | undefined): NoteClass | null {
  if (!raw || raw === "all") return null;
  if (raw === "opd" || raw === "discharge_summary" || raw === "ot") return raw;
  // CDMSS accepts both spellings of the discharge class.
  if (raw === "discharge") return "discharge_summary";
  return null;
}

/**
 * One signal as upstream sends it. Only the fields the portal reads by name are typed; everything
 * else upstream sends (triage, ruling, reference, doctor_uid, overdue, sla_due_at, ...) is
 * deliberately absent from this type and therefore unreachable from portal code.
 */
export interface DoctorAuditSignal {
  signal_id: string;
  signal_type?: string;
  label?: string;
  response_required?: string;
  status?: string;
  instances?: number;
  representative?: Record<string, unknown> | null;
  response?: unknown | null;
  routed?: boolean | null;
  note_class?: string | null;
  note_date?: string | null;
  evidence_excerpt?: string | null;
  citations?: unknown;
  patient?: unknown;
  [extra: string]: unknown;
}

/** The upstream envelope. Only `signals` is read. */
export interface DoctorAuditsUpstream {
  ok: boolean;
  signals: DoctorAuditSignal[];
  [extra: string]: unknown;
}

/** The doctor's own reaction to one signal. Private: it notifies nobody and goes nowhere near the
 *  care-manager workflow. `at` is an ISO timestamp as CDMSS sends it. */
export interface PortalReaction { reaction: string; at: string }

/** signal_id → that doctor's reaction. The shape of the reactions GET's `reactions` object. */
export type ReactionMap = Record<string, PortalReaction | undefined>;

/**
 * Fetch one doctor's routed findings. THROWS on any failure — a missing key, a non-2xx, a timeout.
 * The route catches and converts that into the honest `upstream_unavailable` state; an outage must
 * never be allowed to render as "you have no findings".
 */
export async function fetchDoctorAudits(
  doctorUid: string,
  params: { window: number; status: string; note_class?: NoteClass },
): Promise<DoctorAuditsUpstream> {
  const key = process.env.GOV_API_KEY;
  if (!key) throw new Error("GOV_API_KEY not configured");
  const qs = new URLSearchParams({
    doctor_uid: doctorUid,
    window: String(params.window),
    status: params.status,
  });
  if (params.note_class) qs.set("note_class", params.note_class);
  const res = await fetch(`${BASE}/api/governance/doctor-audits?${qs.toString()}`, {
    headers: { "x-api-key": key },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`CDMSS doctor-audits API ${res.status}: ${body}`);
  }
  return (await res.json()) as DoctorAuditsUpstream;
}

/**
 * Fetch this doctor's own reactions, keyed by signal_id. THROWS on any failure, like the audits
 * fetch — but the findings route treats a throw here very differently: reactions are an ENHANCEMENT
 * to a panel that must still render. A doctor whose reactions could not be read sees their findings
 * with no reaction recorded, not an outage page.
 *
 * `physicianId` is the portal's own identifier and is sent so CDMSS can scope the read to one
 * person; it is taken from the session by the caller and never from a request body.
 */
export async function fetchDoctorReactions(
  doctorUid: string,
  physicianId: string,
): Promise<ReactionMap> {
  const key = process.env.GOV_API_KEY;
  if (!key) throw new Error("GOV_API_KEY not configured");
  const qs = new URLSearchParams({ doctor_uid: doctorUid, physician_id: physicianId });
  const res = await fetch(`${BASE}/api/governance/signal-reaction?${qs.toString()}`, {
    headers: { "x-api-key": key },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`CDMSS signal-reaction API ${res.status}: ${body}`);
  }
  const j = (await res.json()) as { reactions?: unknown };
  return normalizeReactions(j?.reactions);
}

/** PURE. Anything upstream calls a reactions map → a map this module will vouch for. A malformed
 *  entry is dropped rather than rendered, so a shape change degrades to "no reaction recorded". */
export function normalizeReactions(raw: unknown): ReactionMap {
  const out: ReactionMap = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [signalId, v] of Object.entries(raw as Record<string, unknown>)) {
    const r = toReaction(v);
    if (r) out[signalId] = r;
  }
  return out;
}

/** PURE. One reaction entry, whitelisted to the two fields the card renders. */
export function toReaction(v: unknown): PortalReaction | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.reaction !== "string" || !o.reaction) return null;
  return { reaction: o.reaction, at: typeof o.at === "string" ? o.at : "" };
}
