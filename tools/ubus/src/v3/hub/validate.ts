import type { AllowList } from "../filter.js";
import { checkFilter } from "../filter.js";
import { NODES } from "./config.js";

export const EVENT_KINDS = ["agent.seen", "agent.state", "agent.gone", "lane.done", "alert", "node.heartbeat"] as const;
export const STATES = ["working", "idle", "stalled", "errored", "finished", "offline"] as const;
export const AGENT_KINDS = ["claude-code", "opencode", "codex", "herdr-pane"] as const;
export const RUNTIMES = ["max", "bedrock", "bc1", "bc2", "opencode-bedrock", "unknown"] as const;
export const FIELD_MAX = 280;
export const MAX_BATCH = 500;
export const MAX_META_KEYS = 16;
export const MAX_NUMBER_DIGITS = 9;
export const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
/** Exactly 32 lowercase hex characters, at least one letter, no run of 7+ digits: an epoch can never look like a phone/UHID number. */
export const EPOCH_RE = /^(?=[0-9a-f]*[a-f])(?![0-9a-f]*\d{7})[0-9a-f]{32}$/;
const META_KEY = /^[a-z_][a-z0-9_]{0,40}$/;

export const digitCount = (n: number): number => String(Math.abs(n)).replace(/\D/g, "").length;

export interface HubAgent {
  id: string;
  kind: string;
  pane: string | null;
  lane: string | null;
  model: string | null;
  runtime: string;
  pid: number | null;
}

export interface NodeEvent {
  v: 1;
  node: string;
  epoch: string;
  seq: number;
  ts: string;
  kind: (typeof EVENT_KINDS)[number];
  agent: HubAgent | null;
  state: (typeof STATES)[number] | null;
  reason: string | null;
  meta: Record<string, string | number | boolean | null>;
}

export type Checked = { ok: true; event: NodeEvent } | { ok: false; rule: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const oneOf = (list: readonly string[], v: unknown): boolean => typeof v === "string" && list.includes(v);

function strOrNull(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : undefined;
}

/** Schema, size and filter checks for one event. The result carries a rule id, never the offending text. */
export function checkEvent(raw: unknown, allow: AllowList): Checked {
  if (!isObj(raw)) return { ok: false, rule: "schema.not_object" };
  if (raw.v !== 1) return { ok: false, rule: "schema.version" };
  if (!oneOf(NODES, raw.node)) return { ok: false, rule: "schema.node" };
  if (typeof raw.epoch !== "string" || !EPOCH_RE.test(raw.epoch)) return { ok: false, rule: "schema.epoch" };
  if (!Number.isSafeInteger(raw.seq) || (raw.seq as number) < 1 || digitCount(raw.seq as number) > MAX_NUMBER_DIGITS) return { ok: false, rule: "schema.seq" };
  if (typeof raw.ts !== "string" || !ISO_TS.test(raw.ts) || !Number.isFinite(Date.parse(raw.ts))) return { ok: false, rule: "schema.ts" };
  if (!oneOf(EVENT_KINDS, raw.kind)) return { ok: false, rule: "schema.kind" };
  const state = raw.state ?? null;
  if (state !== null && !oneOf(STATES, state)) return { ok: false, rule: "schema.state" };
  const reason = strOrNull(raw.reason);
  if (reason === undefined) return { ok: false, rule: "schema.reason" };
  if (reason !== null && !/^[a-z0-9_.:-]+$/i.test(reason)) return { ok: false, rule: "schema.reason" };

  let agent: HubAgent | null = null;
  if (raw.agent !== null && raw.agent !== undefined) {
    const a = raw.agent;
    if (!isObj(a)) return { ok: false, rule: "schema.agent" };
    const id = a.id;
    if (typeof id !== "string" || !new RegExp(`^[A-Za-z0-9_.-]+@${raw.node}$`).test(id)) return { ok: false, rule: "schema.agent_id" };
    if (!oneOf(AGENT_KINDS, a.kind)) return { ok: false, rule: "schema.agent_kind" };
    const pane = strOrNull(a.pane);
    const lane = strOrNull(a.lane);
    const model = strOrNull(a.model);
    if (pane === undefined || lane === undefined || model === undefined) return { ok: false, rule: "schema.agent" };
    if (!oneOf(RUNTIMES, a.runtime ?? "unknown")) return { ok: false, rule: "schema.runtime" };
    const pid = a.pid ?? null;
    if (pid !== null && (!Number.isSafeInteger(pid) || digitCount(pid as number) > MAX_NUMBER_DIGITS)) return { ok: false, rule: "schema.pid" };
    agent = { id, kind: a.kind as string, pane, lane, model, runtime: (a.runtime as string) ?? "unknown", pid: pid as number | null };
  }
  if (String(raw.kind).startsWith("agent.") && !agent) return { ok: false, rule: "schema.agent_required" };
  if (raw.kind === "agent.state" && !state) return { ok: false, rule: "schema.state_required" };

  const meta: NodeEvent["meta"] = {};
  if (raw.meta !== undefined && raw.meta !== null) {
    if (!isObj(raw.meta)) return { ok: false, rule: "schema.meta" };
    const keys = Object.keys(raw.meta);
    if (keys.length > MAX_META_KEYS) return { ok: false, rule: "schema.meta" };
    for (const k of keys) {
      const v = raw.meta[k];
      if (!META_KEY.test(k)) return { ok: false, rule: "schema.meta_key" };
      if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return { ok: false, rule: "schema.meta" };
      if (typeof v === "number" && (!Number.isFinite(v) || digitCount(v) > MAX_NUMBER_DIGITS)) return { ok: false, rule: "meta.long_number" };
      meta[k] = v as string | number | boolean | null;
    }
  }

  // Every string that leaves the node must be short and pass the P0 filter.
  const strings: string[] = [raw.ts, ...Object.keys(meta)];
  if (reason) strings.push(reason);
  if (agent) for (const s of [agent.id, agent.pane, agent.lane, agent.model]) if (s) strings.push(s);
  for (const v of Object.values(meta)) if (typeof v === "string") strings.push(v);
  for (const s of strings) if (s.length > FIELD_MAX) return { ok: false, rule: "too_long" };
  for (const s of strings) {
    const verdict = checkFilter(s, allow);
    if (!verdict.ok) return { ok: false, rule: verdict.rule_id };
  }
  return {
    ok: true,
    event: { v: 1, node: raw.node as string, epoch: raw.epoch, seq: raw.seq as number, ts: raw.ts, kind: raw.kind as NodeEvent["kind"], agent, state: state as NodeEvent["state"], reason, meta },
  };
}
