/**
 * lib/mcp/profile.ts — S3 (8 Oct 2026), made ONE LIST by S1A (V's Q3 ruling, 8 Oct 17:20 IST: the
 * Scribe MCP is for admins only, so everything is visible to everyone).
 *
 * tools/list returns every listed tool with a SHORT description (plain <= 200 chars, groups <= 400);
 * the long text moves to `help`, which scribe_help returns. The profile selectors (header
 * X-Scribe-Profile, ?profile=, the /lab routes) are kept and resolve, but both profiles return the
 * same list. tools/call is profile-blind: every accepted name works (lib/mcp/surface CALLABLE_TOOLS).
 *
 * The listed view of a tool is a COPY with a short description and the original text moved to
 * `help`. Tool files are untouched; input schemas are untouched.
 */
import type { McpTool } from "./registry";
import { CALLABLE_TOOLS, LAB_TOOLS, groupProbes } from "./surface";

export type McpProfile = "operator" | "lab";
export const DEFAULT_PROFILE: McpProfile = "operator";

export const LISTED_PLAIN_MAX_CHARS = 200;
export const LISTED_GROUP_MAX_CHARS = 400;

/** `aspect=all|stt|…` — generated from the variant table, so it cannot drift from the routing. */
function selector(name: string): string {
  const group = CALLABLE_TOOLS.get(name)!;
  const probes = groupProbes(group);
  const key = Object.keys(probes[0]?.probe ?? {})[0] ?? "view";
  return `${key}=${probes.map((p) => p.value).join("|")}`;
}

const READ_NO_ROOM = "Read-only; touches no room. Times UTC.";
const READ_LIVE = "Read-only; reads live rooms. Times UTC.";

const NO_ROOM_READ = READ_NO_ROOM;
const CAVEATS = "tape_advancing is not audio arriving; zero_ratio>=0.98 = digital silence; levels can freeze after a drop.";

/** One short description per listed tool. Group lines carry a generated selector; the rest are fixed text. */
function briefs(): Record<string, string> {
  return {
    scribe_health: `${READ_NO_ROOM} ${selector("scribe_health")} (default all) probes.`,
    scribe_system: `${READ_NO_ROOM} ${selector("scribe_system")}.`,
    scribe_rooms: `${READ_LIVE} ${selector("scribe_rooms")}. ${CAVEATS}`,
    scribe_get_state: `${NO_ROOM_READ} Brain picture for a room-day: visits, active visit, clusters (no vectors). Never creates a day.`,
    scribe_list_cues: `${NO_ROOM_READ} Brain cues for a room-day, newest first; summary only (payload: include_payload).`,
    scribe_post_cue: "WRITE; adds a cue to a live brain day, sends no room command. Times UTC.",
    scribe_pin_visit: "WRITE; operator pin cue (visit phase) on a live brain day; never edits the visit table, no room command. Times UTC.",
    scribe_room_command: `WRITE; acts on a LIVE clinical room. Times UTC. ${selector("scribe_room_command")}. Needs an open kiosk listener (else kiosk_not_listening); start_day idempotent; room_paused is consent; no start/stop on a room with patients without V's GO.`,
    scribe_sessions: `${READ_NO_ROOM} ${selector("scribe_sessions")}; replay is a dry run that writes nothing.`,
    scribe_session_tape: `Read-only; may quote operator notes and presigned audio links; touches no room. Times UTC. ${selector("scribe_session_tape")}.`,
    scribe_mark_consult: "WRITE; marks a consult on the active session (bench_event + cue); no room command. Times UTC.",
    scribe_extract_audio: "INVOKE scope; presigned audio links for an IST window; writes no row, touches no room. Times UTC.",
    scribe_transcribe_range: "INVOKE scope; transcribes an audio window (text only, never bytes); refused over 30 min and while any room records. Times UTC.",
    scribe_list_commands: `${READ_LIVE} Room command queue, newest first.`,
    scribe_scratch: `WRITE to SCRATCH room-days only, never a live room. Times UTC. ${selector("scribe_scratch")}.`,
    scribe_stt_runs: "Read-only; may quote identity; touches no room. Times UTC. No id lists subjects; subject_id or encounter_id lists runs.",
    scribe_voice: `Read-only; names clinicians and returns presigned audio with include_urls; touches no room. Times UTC. ${selector("scribe_voice")}.`,
    scribe_silence_readjudicate: "WRITE only with apply:true (dry run by default); re-runs silent windows, no live-room command. Times UTC.",
    scribe_diarize_segments: `${NO_ROOM_READ} Speaker timings without text for an encounter_id, window_id or session_id.`,
    scribe_encounter_hypotheses: `${NO_ROOM_READ} Encounter-clock hypotheses for a room-day: latest smoother run, intervals.`,
    scribe_encounter_shadow_run: "INVOKE scope; runs the encounter clock over a room-day, stores hypotheses; no STT, no clinician-facing write, no live room. Times UTC.",
    scribe_list_encounters: `${NO_ROOM_READ} Doctor-PWA encounters, status and pipeline flags; filter by bucket, window, doctor.`,
    scribe_encounter: "Read-only; touches no room. Times UTC. One doctor-PWA encounter (encounter_id) or LLM trace (trace_id); pass exactly one.",
    scribe_list_traces: `${NO_ROOM_READ} LLM pipeline traces; filter by surface, status, window.`,
    scribe_set_visit_clinician: "WRITE; names the clinician on one visit (the only change a closed visit accepts); no room command. Times UTC.",
    scribe_fuse_report: `${NO_ROOM_READ} Fuse scoreboard for one room-day: marks vs warehouse vs visits vs tape, disagreements.`,
    scribe_job_submit: "INVOKE scope; queues long work, returns a job id fast; a job can read room audio, no live-room command. Times UTC.",
    scribe_job_status: `${NO_ROOM_READ} One job: status, step, attempts, progress, error_code, timings.`,
    scribe_job_list: `${NO_ROOM_READ} Job queue, newest first; filter by status and kind.`,
    scribe_job_cancel: "WRITE; cancels a queued or running job; no room command. Times UTC.",
    scribe_jobs: `Reads and writes the job queue; status/list need read, submit needs invoke, cancel needs write; a job can read room audio, no live-room command. Times UTC. ${selector("scribe_jobs")}.`,
    scribe_audit_recent: `${READ_NO_ROOM} Recent audit_log rows, newest first.`,
    scribe_jev_window_run: "INVOKE scope; submits jev_window for a room-day, persists signal rows; no live-room command. Times UTC.",
    scribe_jev_signals: `${NO_ROOM_READ} Jev window signal rows for a room-day (phase, probabilities); never transcript text.`,
    scribe_jev_decisions: `${NO_ROOM_READ} Jev decision log rows (closed-vocabulary answers); never transcript or state text.`,
    scribe_note_safety_replay: "INVOKE scope; shadow-evaluates one encounter's existing note for safety; regenerates no note, shows nothing to clinicians. Times UTC.",
    scribe_clinical_route_replay: "INVOKE scope; classifies a room-day's windows as clinical or not; no live-room command. Times UTC.",
    scribe_room_levels: `${READ_LIVE} ${CAVEATS}`,
    scribe_diarize_spend: `${NO_ROOM_READ} Diarization labels per IST day: windows per engine, hours, estimated euros.`,
    scribe_room_alerts: `${READ_LIVE} Room Watchdog alert outbox (new, late, heartbeat).`,
    scribe_help: "Read-only; touches no room. One tool's full contract: scope, schema, long help; accepts any name. Times UTC.",
    scribe_usage: "Read-only; touches no room. Door usage (audit_log): calls, errors, p50/p95 per tool and actor. Times UTC.",
    // S1 reads (S1A)
    scribe_now: "Read-only; reads live rooms. Times UTC. tape_advancing is not audio arriving: trust state + ages_s; zero_ratio>=0.98 = digital silence; levels can freeze after a drop.",
    scribe_room: "Read-only; reads a live room. Times UTC. tape_advancing is not audio arriving; zero_ratio>=0.98 = digital silence; levels can freeze after a drop.",
    scribe_steward_command: "WRITE; Room Steward config; can act on LIVE rooms. Times UTC; reason required; returns a revert.",
    scribe_lanes: "Read-only; touches no room. Times UTC. Fleet and lane state (lab bucket): name, age_s, stale > 600 s.",
    scribe_rubric: "Job queue read/write; stored data, never Pulse; touches no room. Times UTC. run/bench need invoke; draft rubrics need lab:true + unit_keys.",
    scribe_sarvam: "Job queue read/write; Sarvam (ZDR): consult/encounter audio; MCP research also room windows/segments, never blind days. Times UTC. Job submits need invoke.",
    scribe_reb_index: "Read-only; touches no room. Times UTC. REB track index rows (layer, engine, R2 key) per window_id or IST date; shadow on request.",
    scribe_steward: "Read-only; touches no room. Times UTC. Steward views; why needs room + at (+-15 min). No ticket signatures.",
    scribe_kiosks: "Read-only; reads live kiosks' stored reports, sends no command. Times UTC; room optional.",
    scribe_stt_windows: "Read-only; touches no room. Times UTC. One STT window (window_id) or a room's windows per IST day. No transcript text.",
    scribe_tape_day: `${NO_ROOM_READ} Minutes per audio state per room for one IST day; include_segments (needs room) adds intervals.`,
  };
}

/** Longest property description tools/list carries; the full text stays in the registry and scribe_help returns it. */
export const LISTED_PROP_DESC_MAX_CHARS = 22;

/** Listed property descriptions that must keep a word the 32-char cut would lose (tool -> property -> text). The full text stays in scribe_help. */
const LISTED_PROP_OVERRIDES: Record<string, Record<string, string>> = {
  scribe_room_command: { override_pause: "[kind=start_day] over a consent pause" },
  scribe_rubric: { set: "bench: gold|grokbot_agreement|human_v|evr_perturb" },
  // DT-1/2/3 (REFUTE-DIET2): tags whose 22-char cut stated a wrong default, lost the view that selects them, or dropped a fact scribe_help carries
  scribe_set_visit_clinician: { confidence: "omitted → 0.95; null clears" },
  scribe_scratch: { dry_run: "[action=fuse] default true" },
  scribe_session_tape: { chunk_idx: "[view=chunk] required", source: "[view=chunk] mic stream" },
  scribe_post_cue: { type: "open type minus blocklist", at: "ISO; default now" },
  scribe_pin_visit: { at: "ISO; default now" },
  scribe_extract_audio: { ist_date: "IST date; default today" },
  scribe_transcribe_range: { ist_date: "IST date; default today" },
  scribe_get_state: { ist_date: "IST date; default today" },
  scribe_list_cues: { ist_date: "IST date; default today" },
};

/** `text` cut to <= max chars at a sentence end if one fits, else at a word boundary with an ellipsis. */
export function shortText(text: string, max: number = LISTED_PROP_DESC_MAX_CHARS): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const stop = t.slice(0, max).search(/[.;:]\s[^.;:]*$|[.;]$/);
  if (stop > 8) return t.slice(0, stop + 1);
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  if (sp > 12) return `${cut.slice(0, sp).replace(/[\s,;:(\-]+$/, "")}…`;
  // one long token (a [kind=a|b|c] tag): cut after the last separator, never in the middle of a name
  const bar = Math.max(cut.lastIndexOf("|"), cut.lastIndexOf(","));
  if (bar > 8) return `${cut.slice(0, bar + 1).replace(/[\s,;:(\-]+$/, "")}…`;
  // no separator inside the cut: keep the whole first name (to its separator) rather than cut it in the middle
  const next = t.slice(max - 1).search(/[|,\]\s]/);
  return next >= 0 ? `${t.slice(0, max - 1 + next + 1).replace(/[\s,;:(\-]+$/, "")}…` : `${cut.replace(/[\s,;:(\-]+$/, "")}…`;
}

/** The schema with every property/array-item `description` shortened. Structure, types, enums, required, bounds: untouched. */
export function shortSchema<T>(schema: T): T {
  const walk = (o: unknown, key?: string): unknown => {
    if (Array.isArray(o)) return o.map((x) => walk(x));
    if (o && typeof o === "object") {
      return Object.fromEntries(Object.entries(o as Record<string, unknown>).map(([k, v]) => [k, k === "description" && typeof v === "string" && key !== "properties" ? shortText(v) : walk(v, k)]));
    }
    return o;
  };
  return walk(schema) as T;
}

export function withOverrides<T>(tool: string, schema: T): T {
  const ov = LISTED_PROP_OVERRIDES[tool];
  if (!ov) return schema;
  const s = JSON.parse(JSON.stringify(schema)) as { properties?: Record<string, { description?: string }> };
  for (const [k, text] of Object.entries(ov)) { const prop = s.properties?.[k]; if (!prop) throw new Error(`profile: override for ${tool}.${k}, which is not a property`); prop.description = text; }
  return s as T;
}

function build(): McpTool[] {
  const text = briefs();
  const names = new Set(LAB_TOOLS.map((t) => t.name));
  for (const n of Object.keys(text)) if (!names.has(n)) throw new Error(`profile: brief for ${n}, which is not a listed tool`);
  return LAB_TOOLS.map((full) => {
    const description = text[full.name];
    if (description === undefined) throw new Error(`profile: listed tool ${full.name} has no short description`);
    const isGroup = groupProbes(full).length > 0;
    const max = isGroup ? LISTED_GROUP_MAX_CHARS : LISTED_PLAIN_MAX_CHARS;
    if (description.length > max) throw new Error(`profile: ${full.name} description is ${description.length} chars (max ${max})`);
    return { ...full, description, help: full.help ?? full.description, inputSchema: withOverrides(full.name, shortSchema(full.inputSchema)) };
  });
}

// Built on first use, not at import: the diet reads the whole surface, and a test that fakes the
// surface for the handler must not pay for (or trip over) a real operator list it never asks for.
let cached: { list: readonly McpTool[]; byName: ReadonlyMap<string, McpTool> } | null = null;
const operator = () => (cached ??= (() => { const list = build(); return { list, byName: new Map(list.map((t) => [t.name, t])) }; })());

export const listedTools = (): readonly McpTool[] => operator().list;
/** The listed view of a tool (short description + `help`), or undefined for a name not in the list. */
export const listedTool = (name: string): McpTool | undefined => operator().byName.get(name);

/** One list for everyone (Q3): the profile no longer changes tools/list. */
export function toolsForProfile(_profile: McpProfile): readonly McpTool[] {
  return listedTools();
}

/** header X-Scribe-Profile, then ?profile=, then the route's path flag, then operator. Junk values fall through. */
export function resolveProfile(req: Request, pathFlag?: McpProfile): McpProfile {
  const ok = (v: string | null | undefined): McpProfile | null => {
    const s = v?.trim().toLowerCase();
    return s === "operator" || s === "lab" ? s : null;
  };
  let query: string | null = null;
  try {
    query = new URL(req.url).searchParams.get("profile");
  } catch {
    query = null;
  }
  return ok(req.headers.get("x-scribe-profile")) ?? ok(query) ?? pathFlag ?? DEFAULT_PROFILE;
}
