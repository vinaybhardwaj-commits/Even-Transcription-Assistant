/**
 * lib/mcp/surface.ts — what tools/list publishes, and every name tools/call accepts (Slice E).
 *
 * ─── A REGROUP, NOT A RENAME ─────────────────────────────────────────────────────────────────
 * The door published 51 tools at 6b2347e. Clients cache that list (the Claude.ai connector and
 * Claude Code's MCP client both do), so a name that disappears looks broken to a cached caller
 * for as long as the cache lives. So no tool object below is edited, wrapped or re-implemented:
 *
 *   - PUBLISHED_TOOLS is the 51, exactly the objects the tool files export.
 *   - A GROUP is a new primary whose handler picks ONE of those objects by an argument (`view`,
 *     `aspect`, `source`, `action`, `kind`, or which id was passed) and calls that object's own
 *     handler with the caller's context. Behaviour, refusals and response shape are therefore the
 *     original tool's by construction — there is no second implementation to drift.
 *   - LISTED_TOOLS (tools/list) = the groups, plus every published tool no group took.
 *   - CALLABLE_TOOLS (tools/call) = every published name → its original object, then every group
 *     name → the group. Two group names ARE published names (scribe_health, scribe_room_command):
 *     for those the group answers, and a call shaped the old way (no aspect; one of the three old
 *     kinds) reaches the original handler with the same arguments.
 *
 * ─── WHAT A GROUP MAY HOLD ────────────────────────────────────────────────────────────────────
 * One scope only — buildGroup throws at module load otherwise, so a group can never make the
 * door's single `principal.scopes.has(tool.scope)` check wrong for one of its variants. Read and
 * write never share a group for the same reason. Which tools may sit together beyond that (quoting
 * identity or audio, argument count) was ruled per group in the Slice E proposal; it is not
 * something this file can check.
 *
 * lib/mcp/tools/stt.ts and lib/mcp/tools/voice.ts are NOT grouped in this commit: another slice
 * owns both files until it merges. Their tools are listed exactly as before.
 */

import type { McpTool, ToolArgs } from "./registry";
import { HEALTH_TOOLS } from "./tools/health";
import { BRAIN_TOOLS } from "./tools/brain";
import { BENCH_TOOLS } from "./tools/bench";
import { STT_TOOLS } from "./tools/stt";
import { VOICE_TOOLS } from "./tools/voice";
import { ENCOUNTER_TOOLS } from "./tools/encounters";
import { STORE_TOOLS } from "./tools/stores";
import { LLM_TOOLS } from "./tools/llm";
import { FUSE_TOOLS } from "./tools/fuse";
import { FUSE_REPORT_TOOLS } from "./tools/fuse-report";
import { JOB_TOOLS } from "./tools/jobs";

/** Every tool the door published before Slice E, in the order tools/list served them. */
export const PUBLISHED_TOOLS: readonly McpTool[] = [
  ...HEALTH_TOOLS, ...BRAIN_TOOLS, ...BENCH_TOOLS, ...STT_TOOLS, ...VOICE_TOOLS, ...ENCOUNTER_TOOLS,
  ...STORE_TOOLS, ...LLM_TOOLS, ...FUSE_TOOLS, ...FUSE_REPORT_TOOLS, ...JOB_TOOLS,
];

const PUBLISHED_BY_NAME = new Map(PUBLISHED_TOOLS.map((t) => [t.name, t]));

function published(name: string): McpTool {
  const t = PUBLISHED_BY_NAME.get(name);
  if (!t) throw new Error(`surface: "${name}" is not a published tool`);
  return t;
}

// ---------------------------------------------------------------------------
// The group builder
// ---------------------------------------------------------------------------

export type GroupVariant = {
  /** The selector value (or, for an id-routed group, a label) that picks this tool. */
  value: string;
  tool: McpTool;
  /** Arguments handed to the tool. Default: the caller's arguments without the selector key. */
  args?: (args: ToolArgs) => ToolArgs;
  /** Prepended to the tool's own description inside the group's description. */
  note?: string;
};

export type GroupRefusal = { ok: false; error: string; allowed?: string[]; detail?: string };

const isVariant = (x: GroupVariant | GroupRefusal): x is GroupVariant => "tool" in x;

export type GroupSpec = {
  name: string;
  /** What the group is about. The builder adds how variants run and every variant's own text. */
  lead: string;
  variants: GroupVariant[];
  /** The argument that picks the variant. Absent → `route` must be given. */
  selector?: { key: string; description: string; default?: string };
  /** Picks the variant without a selector (e.g. by which id was passed). */
  route?: (args: ToolArgs) => GroupVariant | GroupRefusal;
  /** Member properties the group does not publish because the selector sets them. */
  hide?: string[];
};

const withoutKey = (args: ToolArgs, key: string | undefined): ToolArgs => {
  if (!key || !(key in args)) return args;
  const out = { ...args };
  delete out[key];
  return out;
};

/**
 * Build one primary from existing tools. Throws at module load — never at call time — on a group
 * that mixes scopes, repeats a value, or whose selector would silently shadow a member's own
 * argument (a variant that wants the selector passed through must say so with `args`).
 */
export function buildGroup(spec: GroupSpec): McpTool {
  const { name, selector: sel, variants } = spec;
  if (variants.length < 2) throw new Error(`surface: group ${name} needs at least two variants`);
  const scopes = [...new Set(variants.map((v) => v.tool.scope))];
  if (scopes.length !== 1) throw new Error(`surface: group ${name} mixes scopes (${scopes.join(", ")})`);
  const values = variants.map((v) => v.value);
  if (new Set(values).size !== values.length) throw new Error(`surface: group ${name} repeats a value`);
  if (!sel && !spec.route) throw new Error(`surface: group ${name} has neither a selector nor a route`);
  if (sel?.default !== undefined && !values.includes(sel.default)) {
    throw new Error(`surface: group ${name} defaults to "${sel.default}", which is not a value`);
  }
  if (sel) {
    for (const v of variants) {
      if (sel.key in (v.tool.inputSchema.properties ?? {}) && !v.args) {
        throw new Error(`surface: group ${name}'s selector "${sel.key}" is also an argument of ${v.tool.name}`);
      }
    }
  }

  const route =
    spec.route ??
    ((args: ToolArgs): GroupVariant | GroupRefusal => {
      const given = args[sel!.key];
      const value = given === undefined ? sel!.default : given;
      const hit = variants.find((v) => v.value === value);
      // Same keys as scribe_room_command's own refusal ({ ok, error: "unknown_kind", allowed }).
      return hit ?? { ok: false, error: `unknown_${sel!.key}`, allowed: values };
    });

  const group: McpTool = {
    name,
    description: describeGroup(spec),
    scope: scopes[0]!,
    inputSchema: groupSchema(spec),
    handler: async (args, ctx) => {
      const picked = route(args);
      if (!isVariant(picked)) return picked;
      // Looked up at call time, not captured, so the object the tool file exports is the one that runs.
      return picked.tool.handler(picked.args ? picked.args(args) : withoutKey(args, sel?.key), ctx);
    },
    memberFor: (args) => {
      const picked = route(args);
      return isVariant(picked) ? picked.tool.name : null;
    },
  };
  MEMBERS.set(group, [...new Set(variants.map((x) => x.tool.name))]);
  return group;
}

const MEMBERS = new WeakMap<McpTool, string[]>();

/** The published tool names a group built by buildGroup can run. Empty for anything else. */
export function groupMembers(group: McpTool): readonly string[] {
  return MEMBERS.get(group) ?? [];
}

function describeGroup(spec: GroupSpec): string {
  const sel = spec.selector;
  const how = sel
    ? `\`${sel.key}\` picks the tool that runs${sel.default ? ` (omitted = ${sel.default})` : ""}.`
    : "Which tool runs is decided as stated above.";
  const head =
    `${spec.lead} ${how} Each variant runs that tool's own handler, so its behaviour, refusals and ` +
    `response shape are that tool's, and that tool's name is still accepted by tools/call. An ` +
    `argument whose description starts with [ … ] applies only to the variants named there.`;
  const parts = spec.variants.map((v) => {
    const label = sel ? `${sel.key}=${v.value} → ${v.tool.name}` : `${v.value} → ${v.tool.name}`;
    return `${label}: ${v.note ? `${v.note} ` : ""}${v.tool.description}`;
  });
  const reused = sel ? reusedNameLead(spec, sel) : null;
  return [...(reused ? [reused] : []), head, ...parts].join("\n\n");
}

/**
 * A group that took a PUBLISHED name opens by saying so. A client that cached the old, narrower
 * schema and a client that sees this one must agree on what the tool does — they may differ only
 * on what it currently lists — so the first thing a cold reader sees is: the old call shape is the
 * old tool, unchanged, and here is every value added, with the tool each one used to be.
 */
function reusedNameLead(spec: GroupSpec, sel: NonNullable<GroupSpec["selector"]>): string | null {
  const own = spec.variants.filter((x) => x.tool.name === spec.name);
  if (own.length === 0) return null;
  const added = spec.variants.filter((x) => x.tool.name !== spec.name);
  const oldValues = own.map((x) => x.value);
  const oldShape =
    sel.default !== undefined && oldValues.includes(sel.default)
      ? `with no \`${sel.key}\` (or ${sel.key}=${sel.default})`
      : `with ${sel.key} ${oldValues.join(" | ")}`;
  const plural = sel.key.endsWith("s") ? `${sel.key}es` : `${sel.key}s`;
  return (
    `SAME TOOL, MORE ${plural.toUpperCase()}. ${spec.name} called ${oldShape} is exactly the ${spec.name} ` +
    `this door has always published: same arguments, same behaviour, same response. ${added.length} ` +
    `${plural} were added, each running what was a separate tool (whose name still works): ` +
    `${added.map((x) => `${x.value} → ${x.tool.name}`).join("; ")}.`
  );
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function groupSchema(spec: GroupSpec): McpTool["inputSchema"] {
  const sel = spec.selector;
  const hide = new Set(spec.hide ?? []);
  const properties: Record<string, unknown> = {};
  if (sel) {
    properties[sel.key] = {
      type: "string",
      enum: spec.variants.map((v) => v.value),
      ...(sel.default !== undefined ? { default: sel.default } : {}),
      description: sel.description,
    };
  }

  // key → the distinct schema fragments for it, each with the variants that declare it that way.
  const seen = new Map<string, Array<{ frag: Record<string, unknown>; values: string[] }>>();
  for (const v of spec.variants) {
    for (const [key, frag] of Object.entries(v.tool.inputSchema.properties ?? {})) {
      if (hide.has(key) || key === sel?.key) continue;
      const list = seen.get(key) ?? [];
      const match = list.find((e) => same(e.frag, frag));
      if (match) match.values.push(v.value);
      else list.push({ frag: frag as Record<string, unknown>, values: [v.value] });
      seen.set(key, list);
    }
  }

  const all = spec.variants.length;
  const tag = (values: string[]) => (sel ? `[${sel.key}=${values.join("|")}]` : `[${values.join("|")}]`);
  const mark = (e: { frag: Record<string, unknown>; values: string[] }) => {
    const own = typeof e.frag.description === "string" ? ` ${e.frag.description}` : "";
    return { ...e.frag, description: `${tag(e.values)}${own}` };
  };
  for (const [key, list] of seen) {
    if (list.length === 1) {
      // Every variant declares it identically → the fragment unchanged. Otherwise marked with its users.
      properties[key] = list[0]!.values.length === all ? list[0]!.frag : mark(list[0]!);
    } else {
      properties[key] = { anyOf: list.map(mark), description: `Declared differently per variant: ${list.map((e) => tag(e.values)).join(", ")}.` };
    }
  }

  return {
    type: "object",
    properties,
    ...(sel && sel.default === undefined ? { required: [sel.key] } : {}),
    additionalProperties: false,
  };
}

// ---------------------------------------------------------------------------
// The groups (commit 1 of Slice E — nothing from stt.ts or voice.ts)
// ---------------------------------------------------------------------------

const v = (value: string, name: string, extra: Partial<GroupVariant> = {}): GroupVariant => ({ value, tool: published(name), ...extra });

/** Keep every argument, the selector included — for a variant whose own argument IS the selector. */
const passThrough = (args: ToolArgs) => args;

const RECORDING_MODES = ["manifest", "timeline", "chunk", "zip"] as const;

export const GROUPS: readonly McpTool[] = [
  buildGroup({
    name: "scribe_health",
    lead: "Health probes, read-only.",
    selector: { key: "aspect", default: "all", description: "all (default) = the composite scribe_health; llm = scribe_llm_health; kb = scribe_kb_probe" },
    variants: [
      v("all", "scribe_health"),
      v("llm", "scribe_llm_health"),
      v("kb", "scribe_kb_probe"),
    ],
  }),
  buildGroup({
    name: "scribe_system",
    lead: "System facts, read-only: the system map and the store counts.",
    selector: { key: "view", description: "map = scribe_system_map; stores = scribe_store_stats" },
    variants: [
      v("map", "scribe_system_map"),
      v("stores", "scribe_store_stats"),
    ],
  }),
  buildGroup({
    name: "scribe_rooms",
    lead: "Rooms, read-only: the room list, the now-picture, the recorder fleet, and one room's day report.",
    selector: { key: "view", description: "list = scribe_list_rooms; now = scribe_diff_room; fleet = scribe_fleet; day_report = scribe_day_report" },
    variants: [
      v("list", "scribe_list_rooms"),
      v("now", "scribe_diff_room"),
      v("fleet", "scribe_fleet"),
      v("day_report", "scribe_day_report"),
    ],
  }),
  buildGroup({
    name: "scribe_sessions",
    lead: "Bench sessions, read-only: the session list, and the dry-run replay of one finished session (writes nothing).",
    selector: { key: "view", description: "list = scribe_list_sessions; replay = scribe_replay_session" },
    variants: [
      v("list", "scribe_list_sessions"),
      v("replay", "scribe_replay_session"),
    ],
  }),
  buildGroup({
    name: "scribe_session_tape",
    lead:
      "One Bench session and its tape, read-only. BOTH variants can quote: session returns the session's event payloads as stored (operator notes included); the recording views return presigned audio links by default.",
    selector: {
      key: "view",
      description: "session = scribe_get_session; manifest | timeline | chunk | zip = scribe_get_recording with that mode",
    },
    variants: [
      v("session", "scribe_get_session"),
      ...RECORDING_MODES.map((mode) =>
        v(mode, "scribe_get_recording", {
          args: (args: ToolArgs) => ({ ...withoutKey(args, "view"), mode }),
          note: `(called with mode=${mode})`,
        }),
      ),
    ],
    hide: ["mode"],
  }),
  buildGroup({
    name: "scribe_encounter",
    lead:
      "One doctor-PWA encounter, or one LLM trace, read-only. Pass EXACTLY ONE of encounter_id (→ scribe_get_encounter) or trace_id (→ scribe_get_trace); both or neither is refused with error one_id_required and nothing runs.",
    variants: [
      v("encounter_id", "scribe_get_encounter"),
      v("trace_id", "scribe_get_trace"),
    ],
    route: (args) => {
      const hasEnc = args.encounter_id !== undefined && args.encounter_id !== null && args.encounter_id !== "";
      const hasTrace = args.trace_id !== undefined && args.trace_id !== null && args.trace_id !== "";
      if (hasEnc === hasTrace) {
        return { ok: false, error: "one_id_required", detail: "pass exactly one of encounter_id or trace_id" };
      }
      return hasEnc ? v("encounter_id", "scribe_get_encounter") : v("trace_id", "scribe_get_trace");
    },
  }),
  buildGroup({
    name: "scribe_ops_log",
    lead: "What has been asked of the system, read-only: the operator command queue, the job queue, and the audit log.",
    selector: { key: "source", description: "commands = scribe_list_commands; jobs = scribe_job_list; audit = scribe_audit_recent" },
    variants: [
      v("commands", "scribe_list_commands"),
      v("jobs", "scribe_job_list"),
      v("audit", "scribe_audit_recent"),
    ],
  }),
  buildGroup({
    name: "scribe_room_command",
    lead:
      "Commands to one room, WRITE scope. Where each kind executes: start_day, pause_day, resume_day and end_day are queued as a bench_command for the room's listening kiosk and acked by it. " +
      "set_audio_input (app 0.1.21+), check_update_now, report_diag and restart_engine (app 0.1.22+) are queued as a bench_command for the native Room Recorder app; a browser kiosk ignores them. " +
      "close_orphaned_session is a SERVER-SIDE REPAIR, not a stop: no command is queued and no kiosk is involved — it ends one orphaned session row on the server.",
    selector: {
      key: "kind",
      description:
        "start_day | pause_day | resume_day | end_day (kiosk); set_audio_input | check_update_now | report_diag | restart_engine (native Room Recorder); close_orphaned_session (server-side repair)",
    },
    variants: [
      v("start_day", "scribe_start_recording"),
      v("pause_day", "scribe_pause_recording"),
      v("resume_day", "scribe_resume_recording"),
      v("end_day", "scribe_stop_recording"),
      v("close_orphaned_session", "scribe_close_orphaned_session"),
      v("set_audio_input", "scribe_set_audio_input"),
      // The three native verbs are scribe_room_command's own `kind` values: `kind` goes through.
      v("check_update_now", "scribe_room_command", { args: passThrough }),
      v("report_diag", "scribe_room_command", { args: passThrough }),
      v("restart_engine", "scribe_room_command", { args: passThrough }),
    ],
  }),
  buildGroup({
    name: "scribe_scratch",
    lead: "WRITES to SCRATCH room-days only: replay a finished session into a scratch graph, or run one fuse arm over a scratch room-day.",
    selector: { key: "action", description: "replay = scribe_replay_write; fuse = scribe_fuse_run" },
    variants: [
      v("replay", "scribe_replay_write"),
      v("fuse", "scribe_fuse_run"),
    ],
  }),
];

// ---------------------------------------------------------------------------
// The two tables the door reads
// ---------------------------------------------------------------------------

/** Every published name a group took, → that group. A name in two groups is a build error. */
const GROUP_OF = new Map<string, McpTool>();
for (const g of GROUPS) {
  for (const member of groupMembers(g)) {
    const prior = GROUP_OF.get(member);
    if (prior) throw new Error(`surface: ${member} is in both ${prior.name} and ${g.name}`);
    GROUP_OF.set(member, g);
  }
}

/** tools/list: each group where its first member used to sit, then every tool no group took. */
export const LISTED_TOOLS: readonly McpTool[] = (() => {
  const out: McpTool[] = [];
  const emitted = new Set<McpTool>();
  for (const t of PUBLISHED_TOOLS) {
    const g = GROUP_OF.get(t.name);
    if (!g) out.push(t);
    else if (!emitted.has(g)) {
      out.push(g);
      emitted.add(g);
    }
  }
  return out;
})();

/** tools/call: every published name, then every group name (a group wins its own name). */
export const CALLABLE_TOOLS: ReadonlyMap<string, McpTool> = new Map<string, McpTool>([
  ...PUBLISHED_TOOLS.map((t) => [t.name, t] as const),
  ...GROUPS.map((g) => [g.name, g] as const),
]);
