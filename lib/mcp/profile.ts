/**
 * lib/mcp/profile.ts — S3 (8 Oct 2026): two tools/list profiles over ONE callable surface.
 *
 *   operator — 13 tools, short descriptions. What a Claude session working the rooms needs.
 *   lab      — every tool the door lists today, plus scribe_jobs, full descriptions.
 *
 * A profile changes ONLY what tools/list returns (and the `instructions` line). tools/call is
 * profile-blind: every accepted name works from either profile (lib/mcp/surface CALLABLE_TOOLS).
 *
 * The operator view of a tool is a COPY with a short description and the original text moved to
 * `help` (scribe_help returns it). Tool files are untouched; input schemas are untouched.
 */
import type { McpTool } from "./registry";
import { CALLABLE_TOOLS, LAB_TOOLS, groupProbes } from "./surface";

export type McpProfile = "operator" | "lab";
export const DEFAULT_PROFILE: McpProfile = "operator";

/** tools/list order for the operator profile. */
export const OPERATOR_TOOL_NAMES = [
  "scribe_health",
  "scribe_system",
  "scribe_rooms",
  "scribe_sessions",
  "scribe_session_tape",
  "scribe_room_levels",
  "scribe_room_alerts",
  "scribe_room_command",
  "scribe_list_commands",
  "scribe_jobs",
  "scribe_audit_recent",
  "scribe_help",
  "scribe_usage",
] as const;

export const OPERATOR_PLAIN_MAX_CHARS = 200;
export const OPERATOR_GROUP_MAX_CHARS = 400;

/** `aspect=all|stt|…` — generated from the variant table, so it cannot drift from the routing. */
function selector(name: string): string {
  const group = CALLABLE_TOOLS.get(name)!;
  const probes = groupProbes(group);
  const key = Object.keys(probes[0]?.probe ?? {})[0] ?? "view";
  return `${key}=${probes.map((p) => p.value).join("|")}`;
}

const READ_NO_ROOM = "Read-only; changes nothing, touches no room. Times UTC.";
const READ_LIVE = "Read-only; reads live rooms, changes nothing. Times UTC.";

/** The operator descriptions. Group lines carry a generated selector; the rest are fixed text. */
function briefs(): Record<(typeof OPERATOR_TOOL_NAMES)[number], string> {
  return {
    scribe_health: `${READ_NO_ROOM} ${selector("scribe_health")} (default all) probes.`,
    scribe_system: `${READ_NO_ROOM} ${selector("scribe_system")}.`,
    scribe_rooms: `${READ_LIVE} ${selector("scribe_rooms")}. tape_advancing does not mean audio is arriving; zero_ratio>=0.98 = digital silence; levels can freeze after a device drop.`,
    scribe_sessions: `${READ_NO_ROOM} ${selector("scribe_sessions")}; replay is a dry run that writes nothing.`,
    scribe_session_tape: `Read-only; may quote operator notes and presigned audio links; touches no room. Times UTC. ${selector("scribe_session_tape")}.`,
    scribe_room_levels: `${READ_LIVE} tape_advancing does not mean audio is arriving; zero_ratio>=0.98 = digital silence; levels can freeze after a device drop.`,
    scribe_room_alerts: `${READ_LIVE} The Room Watchdog alert outbox (new, late, heartbeat) for the relay.`,
    scribe_room_command: `WRITE; acts on a LIVE clinical room. Times UTC. ${selector("scribe_room_command")}. Needs an open kiosk listener (else kiosk_not_listening); start_day idempotent; room_paused is consent; no start/stop on a room with patients without V's GO.`,
    scribe_list_commands: `${READ_LIVE} The room command queue (bench_command), newest first.`,
    scribe_jobs: `Reads and writes the job queue; submit needs invoke, cancel needs write; a job can read room audio, no live-room command. Times UTC. ${selector("scribe_jobs")}.`,
    scribe_audit_recent: `${READ_NO_ROOM} Recent audit_log rows, newest first; metadata as stored.`,
    scribe_help: "Read-only; touches no room. One tool's full contract: scope, schema, and the long help text. Accepts any accepted name. Times UTC.",
    scribe_usage: "Read-only; touches no room. Door usage from audit_log: calls, errors, p50/p95 latency per tool and actor. Times UTC.",
  };
}

function build(): McpTool[] {
  const text = briefs();
  const byName = new Map(LAB_TOOLS.map((t) => [t.name, t]));
  return OPERATOR_TOOL_NAMES.map((name) => {
    const full = byName.get(name);
    if (!full) throw new Error(`profile: operator tool ${name} is not in the lab list`);
    const description = text[name];
    const isGroup = groupProbes(full).length > 0;
    const max = isGroup ? OPERATOR_GROUP_MAX_CHARS : OPERATOR_PLAIN_MAX_CHARS;
    if (description.length > max) throw new Error(`profile: ${name} description is ${description.length} chars (max ${max})`);
    return { ...full, description, help: full.help ?? full.description };
  });
}

// Built on first use, not at import: the diet reads the whole surface, and a test that fakes the
// surface for the handler must not pay for (or trip over) a real operator list it never asks for.
let cached: { list: readonly McpTool[]; byName: ReadonlyMap<string, McpTool> } | null = null;
const operator = () => (cached ??= (() => { const list = build(); return { list, byName: new Map(list.map((t) => [t.name, t])) }; })());

export const operatorTools = (): readonly McpTool[] => operator().list;
/** The operator view of a tool (short description + ), or undefined for a name not in the operator list. */
export const operatorTool = (name: string): McpTool | undefined => operator().byName.get(name);

export function toolsForProfile(profile: McpProfile): readonly McpTool[] {
  return profile === "lab" ? LAB_TOOLS : operatorTools();
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
