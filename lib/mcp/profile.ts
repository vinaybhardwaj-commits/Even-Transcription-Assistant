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

const READ_NO_ROOM = "Read-only; changes nothing, touches no room. Times UTC.";
const READ_LIVE = "Read-only; reads live rooms, changes nothing. Times UTC.";

const NO_ROOM_READ = READ_NO_ROOM;
const CAVEATS = "tape_advancing does not mean audio is arriving; zero_ratio>=0.98 = digital silence; levels can freeze after a device drop.";

/** One short description per listed tool. Group lines carry a generated selector; the rest are fixed text. */
function briefs(): Record<string, string> {
  return {
    scribe_health: `${READ_NO_ROOM} ${selector("scribe_health")} (default all) probes.`,
    scribe_system: `${READ_NO_ROOM} ${selector("scribe_system")}.`,
    scribe_rooms: `${READ_LIVE} ${selector("scribe_rooms")}. ${CAVEATS}`,
    scribe_get_state: `${NO_ROOM_READ} The brain picture for a room-day: visits, active visit, speaker clusters (no vectors). Never creates a day.`,
    scribe_list_cues: `${NO_ROOM_READ} Brain cues for a room-day, newest first; summary only, the payload needs include_payload=true.`,
    scribe_post_cue: "WRITE; adds a cue to a room's live brain day, sends no room command. Times UTC. Open type minus a blocklist; see help.",
    scribe_pin_visit: "WRITE; operator pin cue (visit phase) on a live brain day; never edits the visit table, no room command. Times UTC.",
    scribe_room_command: `WRITE; acts on a LIVE clinical room. Times UTC. ${selector("scribe_room_command")}. Needs an open kiosk listener (else kiosk_not_listening); start_day idempotent; room_paused is consent; no start/stop on a room with patients without V's GO.`,
    scribe_sessions: `${READ_NO_ROOM} ${selector("scribe_sessions")}; replay is a dry run that writes nothing.`,
    scribe_session_tape: `Read-only; may quote operator notes and presigned audio links; touches no room. Times UTC. ${selector("scribe_session_tape")}.`,
    scribe_mark_consult: "WRITE; marks a consult on a room's active session (bench_event + cue); no room command. Times UTC.",
    scribe_extract_audio: "INVOKE scope; maps an IST window onto session chunks and returns presigned audio links; writes no row, touches no room. Times UTC.",
    scribe_transcribe_range: "INVOKE scope; transcribes an audio window (text only, never bytes); refused over 30 min and while any room records. Times UTC.",
    scribe_list_commands: `${READ_LIVE} The room command queue (bench_command), newest first.`,
    scribe_scratch: `WRITE to SCRATCH room-days only, never a live room. Times UTC. ${selector("scribe_scratch")}.`,
    scribe_stt_runs: "Read-only; may quote identity; touches no room. Times UTC. No id lists subjects; subject_id or encounter_id lists that subject's runs.",
    scribe_voice: `Read-only; names clinicians and returns presigned audio with include_urls; touches no room. Times UTC. ${selector("scribe_voice")}.`,
    scribe_silence_readjudicate: "WRITE only with apply:true (dry run by default); re-runs silent windows, no live-room command. Times UTC.",
    scribe_diarize_segments: `${NO_ROOM_READ} Speaker timings without text for an encounter_id, window_id or session_id.`,
    scribe_encounter_hypotheses: `${NO_ROOM_READ} Encounter-clock hypotheses (E-5) for a room-day: the latest smoother run and its intervals.`,
    scribe_encounter_shadow_run: "INVOKE scope; runs the encounter clock over a room-day and stores hypotheses; no STT, no clinician-facing write, no live room. Times UTC.",
    scribe_list_encounters: `${NO_ROOM_READ} Doctor-PWA encounters (admin list) with status and pipeline flags; filter by bucket, window, doctor.`,
    scribe_encounter: "Read-only; touches no room. Times UTC. One doctor-PWA encounter (encounter_id) or one LLM trace (trace_id); pass exactly one.",
    scribe_list_traces: `${NO_ROOM_READ} LLM pipeline traces: surface, status, timings, model, tokens; filter by surface, status, window.`,
    scribe_set_visit_clinician: "WRITE; names the clinician on one visit (the only change a closed visit accepts); no room command. Times UTC.",
    scribe_fuse_report: `${NO_ROOM_READ} The fuse scoreboard for one room-day: marks vs warehouse vs visits vs tape, and every disagreement.`,
    scribe_job_submit: "INVOKE scope; queues long work and returns a job id in under 2 s; a job can read room audio, no live-room command. Times UTC.",
    scribe_job_status: `${NO_ROOM_READ} One job: status, step, attempts, failures, progress, error_code, timings.`,
    scribe_job_list: `${NO_ROOM_READ} The job queue, newest first; filter by status and kind.`,
    scribe_job_cancel: "WRITE; cancels a queued or running job (a running one stops at its next step); no room command. Times UTC.",
    scribe_jobs: `Reads and writes the job queue; status/list need read, submit needs invoke, cancel needs write; a job can read room audio, no live-room command. Times UTC. ${selector("scribe_jobs")}.`,
    scribe_audit_recent: `${READ_NO_ROOM} Recent audit_log rows, newest first; metadata as stored.`,
    scribe_jev_window_run: "INVOKE scope; submits the jev_window job for a room-day and persists signal rows; no live-room command. Times UTC.",
    scribe_jev_signals: `${NO_ROOM_READ} Jev window signal rows for a room-day (phase, probabilities); never transcript text.`,
    scribe_jev_decisions: `${NO_ROOM_READ} Jev decision log rows (closed-vocabulary answers); never transcript or state text.`,
    scribe_note_safety_replay: "INVOKE scope; shadow-evaluates note safety on one encounter's existing note; regenerates no note, shows nothing to clinicians. Times UTC.",
    scribe_clinical_route_replay: "INVOKE scope; classifies each window of a room-day as clinical or not (U6 routing); no live-room command. Times UTC.",
    scribe_room_levels: `${READ_LIVE} ${CAVEATS}`,
    scribe_diarize_spend: `${NO_ROOM_READ} Diarization teacher labels per IST day: windows per engine, audio-hours, estimated paid-engine euros.`,
    scribe_room_alerts: `${READ_LIVE} The Room Watchdog alert outbox (new, late, heartbeat) for the relay.`,
    scribe_help: "Read-only; touches no room. One tool's full contract: scope, schema, and the long help text. Accepts any accepted name. Times UTC.",
    scribe_usage: "Read-only; touches no room. Door usage from audit_log: calls, errors, p50/p95 latency per tool and actor. Times UTC.",
    // S1 reads (S1A)
    scribe_now: "Read-only; reads live rooms. Times UTC. Fleet board. tape_advancing is not audio arriving: trust state + ages_s; zero_ratio>=0.98 = digital silence; levels freeze after a device drop.",
    scribe_room: "Read-only; reads a live room. Times UTC. view=alerts|levels|commands|devices. tape_advancing is not audio arriving; zero_ratio>=0.98 = digital silence; levels freeze after a device drop.",
    scribe_steward_command: "WRITE; changes Room Steward config; can act on LIVE rooms. Times UTC. kind=set_shadow|kill_switch|start_day_live|add_room|flag_room|set_window|note|mute_alerts; reason required; returns a revert.",
    scribe_lanes: "Read-only; touches no room. Times UTC. Fleet and lane state from the lab bucket: view=fleet|lanes (name, age_s, stale > 600 s, summary).",
    scribe_sarvam: "Reads and writes the job queue; consult audio/text only to Sarvam (ZDR); touches no room. Times UTC. action=transcribe|translate|status|result|usage|health; submits need invoke.",
    scribe_reb_index: "Read-only; touches no room. Times UTC. REB track index rows (layer, engine, R2 key, sha256) for a window_id or IST date; shadow rows only on request.",
    scribe_steward: "Read-only; touches no room. Times UTC. Room Steward view=config|decisions|tickets|tick|why; why needs room + at (+-15 min). No ticket signatures.",
    scribe_kiosks: "Read-only; reads live kiosks' stored reports, sends no command. Times UTC. view=health|versions|devices|power|last_seen; room optional.",
    scribe_stt_windows: "Read-only; touches no room. Times UTC. One STT window (window_id) or a room's windows for an IST day: state, drain, jobs, runs. No transcript text.",
    scribe_tape_day: `${NO_ROOM_READ} Minutes per audio state per room for one IST day; include_segments (needs room) adds the state intervals. Writes nothing.`,
  };
}

/** Longest property description tools/list carries; the full text stays in the registry and scribe_help returns it. */
export const LISTED_PROP_DESC_MAX_CHARS = 40;

/** `text` cut to <= max chars at a sentence end if one fits, else at a word boundary with an ellipsis. */
export function shortText(text: string, max: number = LISTED_PROP_DESC_MAX_CHARS): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const stop = t.slice(0, max).search(/[.;:]\s[^.;:]*$|[.;]$/);
  if (stop > 8) return t.slice(0, stop + 1);
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > 12 ? cut.slice(0, sp) : cut).replace(/[\s,;:(\-]+$/, "")}…`;
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
    return { ...full, description, help: full.help ?? full.description, inputSchema: shortSchema(full.inputSchema) };
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
