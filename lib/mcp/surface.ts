/**
 * lib/mcp/surface.ts — what tools/list publishes, and every name tools/call accepts (Slice E).
 *
 * ─── A REGROUP, NOT A RENAME ─────────────────────────────────────────────────────────────────
 * The door published 51 tools at 6b2347e and 52 at 0f27b8c (C2 added scribe_window_speakers).
 * Clients cache that list (the Claude.ai connector and Claude Code's MCP client both do), so a name
 * that disappears looks broken to a cached caller for as long as the cache lives. So no tool object
 * below is edited, wrapped or re-implemented:
 *
 *   - PUBLISHED_TOOLS is every published tool, exactly the objects the tool files export.
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
 * No group absorbs a jobs.ts tool (ruling, 13 Sep), so the job tools, scribe_audit_recent and
 * scribe_list_commands are listed on their own.
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
import { JEV_TOOLS } from "./tools/jev";
import { LEVEL_TOOLS } from "./tools/levels";
import { DIARIZE_LABEL_TOOLS } from "./tools/diarize-labels";
import { ROOM_ALERT_TOOLS } from "./tools/room-alerts";

/**
 * Every tool the door published before Slice E, in the order tools/list served them, plus every
 * tool published since (appended, never inserted, so nothing already published moves).
 */
export const PUBLISHED_TOOLS: readonly McpTool[] = [
  ...HEALTH_TOOLS, ...BRAIN_TOOLS, ...BENCH_TOOLS, ...STT_TOOLS, ...VOICE_TOOLS, ...ENCOUNTER_TOOLS,
  ...STORE_TOOLS, ...LLM_TOOLS, ...FUSE_TOOLS, ...FUSE_REPORT_TOOLS, ...JOB_TOOLS, ...JEV_TOOLS,
  ...LEVEL_TOOLS,
  ...DIARIZE_LABEL_TOOLS,
  ...ROOM_ALERT_TOOLS,
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
  /** Shown after the tool name in the generated value list, e.g. "(with that mode)". */
  note?: string;
  /** Where this variant's work happens. Variants sharing one string are listed together. */
  executes?: string;
  /**
   * Arguments that pick this variant. Required on a group routed by `route` (a selector group uses
   * `{ [key]: value }`). buildGroup routes every probe at load and throws if one lands elsewhere, so
   * the value list in the description cannot claim a routing the code does not do.
   */
  probe?: ToolArgs;
};

export type GroupRefusal = { ok: false; error: string; allowed?: string[]; detail?: string };

const isVariant = (x: GroupVariant | GroupRefusal): x is GroupVariant => "tool" in x;

export type GroupSpec = {
  name: string;
  /**
   * The ONLY hand-written text in a group's description: one or two sentences of framing. Every
   * value, the tool it runs and where it executes are generated from `variants`, so adding or
   * renaming a variant cannot leave the description behind.
   */
  lead: string;
  variants: GroupVariant[];
  /** The argument that picks the variant. Absent → `route` must be given. */
  selector?: { key: string; default?: string };
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

  const probes = variants.map((x) => {
    const probe = sel ? { [sel.key]: x.value } : x.probe;
    if (!probe) throw new Error(`surface: group ${name}'s variant ${x.value} needs a probe`);
    const landed = route(probe);
    if (!isVariant(landed) || landed.tool !== x.tool || landed.value !== x.value) {
      throw new Error(`surface: group ${name}'s probe for ${x.value} does not route to ${x.tool.name}`);
    }
    return { value: x.value, probe, member: x.tool.name };
  });

  const description = describeGroup(spec);
  const words = wordCount(description);
  if (words > GROUP_DESCRIPTION_MAX_WORDS) {
    throw new Error(`surface: group ${name}'s description is ${words} words (max ${GROUP_DESCRIPTION_MAX_WORDS})`);
  }

  const group: McpTool = {
    name,
    description,
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
  PROBES.set(group, probes);
  return group;
}

const MEMBERS = new WeakMap<McpTool, string[]>();
const PROBES = new WeakMap<McpTool, Array<{ value: string; probe: ToolArgs; member: string }>>();

/** The published tool names a group built by buildGroup can run. Empty for anything else. */
export function groupMembers(group: McpTool): readonly string[] {
  return MEMBERS.get(group) ?? [];
}

/** Every variant of a group: its value, arguments that pick it, and the tool that then runs. */
export function groupProbes(group: McpTool): ReadonlyArray<{ value: string; probe: ToolArgs; member: string }> {
  return PROBES.get(group) ?? [];
}

/** Tier 2 §2.4's ceiling for a description, applied to groups and enforced at module load. */
export const GROUP_DESCRIPTION_MAX_WORDS = 150;

export const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Values that run the same tool (with the same note) listed together, in variant order. */
function valueList(variants: readonly GroupVariant[]): string {
  const rows: Array<{ values: string[]; tool: string; note?: string }> = [];
  for (const x of variants) {
    const row = rows.find((r) => r.tool === x.tool.name && r.note === x.note);
    if (row) row.values.push(x.value);
    else rows.push({ values: [x.value], tool: x.tool.name, note: x.note });
  }
  return rows.map((r) => `${r.values.join(" | ")} → ${r.tool}${r.note ? ` ${r.note}` : ""}`).join("; ");
}

/**
 * The description is framing + GENERATED facts, under GROUP_DESCRIPTION_MAX_WORDS. The members'
 * own long descriptions are not copied in: 1,126 words for one tool is unreadable, and a hand-written
 * summary of them is exactly the text that drifts from the code. So only `lead` is prose; every
 * value, tool name and execution site below comes from the variant table that routes the calls.
 */
function describeGroup(spec: GroupSpec): string {
  const sel = spec.selector;
  const parts: string[] = [];
  if (sel) {
    const reused = reusedNameLine(spec, sel);
    if (reused) parts.push(reused);
  }
  parts.push(spec.lead);
  parts.push(
    sel
      ? `\`${sel.key}\`${sel.default ? ` (default ${sel.default})` : ""} picks the tool that runs: ${valueList(spec.variants)}.`
      : `Runs: ${valueList(spec.variants)}.`,
  );
  const sites: Array<{ where: string; values: string[] }> = [];
  for (const x of spec.variants) {
    if (!x.executes) continue;
    const site = sites.find((s) => s.where === x.executes);
    if (site) site.values.push(x.value);
    else sites.push({ where: x.executes, values: [x.value] });
  }
  for (const s of sites) parts.push(`${s.values.join(", ")} — ${s.where}.`);
  const tagged = sel ? `[${sel.key}=…]` : spec.variants.map((x) => `[${x.value}]`).join(" or ");
  parts.push(
    `Each runs that tool's own handler, and every old tool name still works in tools/call. An argument described ${tagged} applies only to those.`,
  );
  return parts.join("\n\n");
}

/**
 * A group that took a PUBLISHED name opens by saying so. A client that cached the old, narrower
 * schema and a client that sees this one must agree on what the tool does — they may differ only
 * on what it currently lists — so the first thing a cold reader sees is that the old call shape is
 * the old tool. The values it gained follow in the generated list.
 */
function reusedNameLine(spec: GroupSpec, sel: NonNullable<GroupSpec["selector"]>): string | null {
  const own = spec.variants.filter((x) => x.tool.name === spec.name).map((x) => x.value);
  if (own.length === 0) return null;
  const oldShape =
    sel.default !== undefined && own.includes(sel.default)
      ? `with no \`${sel.key}\` (or ${sel.key}=${sel.default})`
      : `with ${sel.key} ${own.join(" | ")}`;
  const plural = sel.key.endsWith("s") ? `${sel.key}es` : `${sel.key}s`;
  return `SAME TOOL, MORE ${plural.toUpperCase()}. ${spec.name} called ${oldShape} is the old ${spec.name}: same arguments, same behaviour, same response.`;
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
      description: `picks the tool that runs: ${valueList(spec.variants)}`,
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

/**
 * Where a room command's work happens. Each string is attached to the variants whose handler does
 * exactly that; tests/unit/mcp-surface-aliases.test.ts checks every claim against lib/mcp/tools/bench.ts.
 */
const EXECUTES_KIOSK = "queued as a bench_command for the room's listening kiosk";
const EXECUTES_NATIVE_APP = "queued as a bench_command for the native Room Recorder app, which a browser kiosk ignores";
const EXECUTES_SERVER = "a SERVER-SIDE REPAIR, not a stop: no command is queued and no kiosk is involved";

export const GROUPS: readonly McpTool[] = [
  buildGroup({
    name: "scribe_health",
    lead: "Health probes, read-only.",
    selector: { key: "aspect", default: "all" },
    variants: [
      v("all", "scribe_health"),
      v("stt", "scribe_stt_health"),
      v("voice", "scribe_voice_health"),
      v("llm", "scribe_llm_health"),
      v("kb", "scribe_kb_probe"),
    ],
  }),
  buildGroup({
    name: "scribe_system",
    lead: "System facts, read-only: the system map, the store counts, and the STT engine registry, routing matrix and room-engine tripwires.",
    selector: { key: "view" },
    variants: [
      v("map", "scribe_system_map"),
      v("stores", "scribe_store_stats"),
      v("stt_engines", "scribe_list_stt_engines"),
      v("stt_routing", "scribe_stt_routing"),
      v("stt_tripwires", "scribe_route_tripwires"),
    ],
  }),
  buildGroup({
    name: "scribe_rooms",
    lead: "Rooms, read-only: the room list, the now-picture, the recorder fleet, one room's day report, and one room-day's speaker clusters.",
    selector: { key: "view" },
    variants: [
      v("list", "scribe_list_rooms"),
      v("now", "scribe_diff_room"),
      v("fleet", "scribe_fleet"),
      v("day_report", "scribe_day_report"),
      v("clusters", "scribe_get_clusters"),
    ],
  }),
  buildGroup({
    name: "scribe_sessions",
    lead: "Bench sessions, read-only: the session list, and a dry-run replay of one finished session that writes nothing.",
    selector: { key: "view" },
    variants: [
      v("list", "scribe_list_sessions"),
      v("replay", "scribe_replay_session"),
    ],
  }),
  buildGroup({
    name: "scribe_session_tape",
    lead:
      "One Bench session and its tape, read-only. Both tools can quote: session returns event payloads as stored, operator notes included; manifest and chunk return presigned audio links.",
    selector: { key: "view" },
    variants: [
      v("session", "scribe_get_session"),
      ...RECORDING_MODES.map((mode) =>
        v(mode, "scribe_get_recording", {
          args: (args: ToolArgs) => ({ ...withoutKey(args, "view"), mode }),
          note: "(as its mode)",
        }),
      ),
    ],
    hide: ["mode"],
  }),
  buildGroup({
    name: "scribe_encounter",
    lead:
      "One doctor-PWA encounter or one LLM trace, read-only. Pass exactly one of the two ids; both or neither is refused with one_id_required and nothing runs.",
    variants: [
      v("encounter_id", "scribe_get_encounter", { probe: { encounter_id: "enc_probe" } }),
      v("trace_id", "scribe_get_trace", { probe: { trace_id: "trace_probe" } }),
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
    name: "scribe_stt_runs",
    lead:
      "Batch ASR runs, read-only, and both tools can quote identity. Pass subject_id or encounter_id for one subject's runs; pass neither for the list of subjects.",
    variants: [
      v("no id", "scribe_list_stt_runs", { probe: {} }),
      v("subject_id or encounter_id", "scribe_get_stt_run", { probe: { subject_id: "subject_probe" } }),
    ],
    route: (args) => {
      const given = (k: string) => args[k] !== undefined && args[k] !== null && args[k] !== "";
      return given("subject_id") || given("encounter_id")
        ? v("subject_id or encounter_id", "scribe_get_stt_run")
        : v("no id", "scribe_list_stt_runs");
    },
  }),
  buildGroup({
    name: "scribe_voice",
    lead:
      "Clinician voice, read-only, and every view can quote: prints returns clinician names, samples returns presigned audio links with include_urls, window_speakers returns the clinician a voice matched.",
    selector: { key: "view" },
    variants: [
      v("prints", "scribe_list_voiceprints"),
      v("samples", "scribe_list_voice_samples"),
      v("window_speakers", "scribe_window_speakers"),
    ],
  }),
  buildGroup({
    name: "scribe_room_command",
    lead: "Commands to one room, WRITE scope.",
    selector: { key: "kind" },
    variants: [
      v("start_day", "scribe_start_recording", { executes: EXECUTES_KIOSK }),
      v("pause_day", "scribe_pause_recording", { executes: EXECUTES_KIOSK }),
      v("resume_day", "scribe_resume_recording", { executes: EXECUTES_KIOSK }),
      v("end_day", "scribe_stop_recording", { executes: EXECUTES_KIOSK }),
      v("close_orphaned_session", "scribe_close_orphaned_session", { executes: EXECUTES_SERVER }),
      v("set_audio_input", "scribe_set_audio_input", { executes: EXECUTES_NATIVE_APP }),
      // The three native verbs are scribe_room_command's own `kind` values: `kind` goes through.
      v("check_update_now", "scribe_room_command", { args: passThrough, executes: EXECUTES_NATIVE_APP }),
      v("report_diag", "scribe_room_command", { args: passThrough, executes: EXECUTES_NATIVE_APP }),
      v("restart_engine", "scribe_room_command", { args: passThrough, executes: EXECUTES_NATIVE_APP }),
    ],
  }),
  buildGroup({
    name: "scribe_scratch",
    lead: "WRITES to SCRATCH room-days only: replay a finished session into a scratch graph, or run one fuse arm over a scratch room-day.",
    selector: { key: "action" },
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
