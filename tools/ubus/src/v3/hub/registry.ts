import type { EventRow } from "../eventlog.js";
import type { HubAgent, NodeEvent } from "./validate.js";

export const OFFLINE_AFTER_MS = 90_000;
export const EV_PREFIX = "hub.ev.";
export const REJECTED_KIND = "hub.ev.rejected";
export const ALERT_SENT = "hub.alert.sent";
export const ALERT_FAILED = "hub.alert.failed";
export const ALERT_SKIPPED = "hub.alert.skipped";
export const EPOCH_RESET = "hub.alert.node.epoch_reset";
const ALERT_STATES = new Set(["errored", "stalled"]);

/** An errored/stalled transition that still owes its owner an alert. */
export interface DueAlert {
  sourceEvent: number;
  node: string;
  agent: string;
  lane: string | null;
  state: string;
  reason: string | null;
  /** True once a send has failed; only startup retries these. */
  failed: boolean;
}

export interface AgentRec extends HubAgent {
  node: string;
  state: string | null;
  reason: string | null;
  /** Hub clock time of the last event naming this agent. */
  lastSeen: string;
  stateSince: string | null;
}

export interface AgentView extends AgentRec {
  /** True when the raw state was replaced by "offline" because the node's heartbeat is stale. */
  stale: boolean;
}

interface NodeRec {
  lastEvent: string;
  lastHeartbeat: string | null;
}

const LANE_RANK = ["finished", "errored", "stalled", "working", "idle", "offline"];

/** Materialized agent/node/lane views, folded from the hub.ev.* rows of the P0 event log. */
export class Registry {
  private agents = new Map<string, AgentRec>();
  private nodes = new Map<string, NodeRec>();
  private laneDone = new Map<string, string>();
  /** Keyed node + epoch: seqs seen (stored or rejected) and the highest contiguous one. */
  private seqs = new Map<string, Set<number>>();
  private contiguous = new Map<string, number>();
  private rejections = new Map<string, string>();
  private epochs = new Map<string, string[]>();
  private due = new Map<number, DueAlert>();
  private events = 0;

  clear(): void {
    this.agents.clear();
    this.nodes.clear();
    this.laneDone.clear();
    this.seqs.clear();
    this.contiguous.clear();
    this.rejections.clear();
    this.epochs.clear();
    this.due.clear();
    this.events = 0;
  }

  has(node: string, epoch: string, seq: number): boolean {
    return this.seqs.get(`${node}/${epoch}`)?.has(seq) ?? false;
  }

  /** The rule id an earlier rejection of this (node, epoch, seq) recorded, if any. */
  rejection(node: string, epoch: string, seq: number): string | undefined {
    return this.rejections.get(`${node}/${epoch}/${seq}`);
  }

  ackSeq(node: string, epoch: string): number {
    return this.contiguous.get(`${node}/${epoch}`) ?? 0;
  }

  knowsEpoch(node: string, epoch: string): boolean {
    return this.epochs.get(node)?.includes(epoch) ?? false;
  }

  hasEpochs(node: string): boolean {
    return (this.epochs.get(node)?.length ?? 0) > 0;
  }

  currentEpoch(node: string): string | null {
    const list = this.epochs.get(node);
    return list?.length ? list[list.length - 1] : null;
  }

  dueAlerts(): DueAlert[] {
    return [...this.due.values()];
  }

  eventCount(): number {
    return this.events;
  }

  agent(id: string): AgentRec | undefined {
    return this.agents.get(id);
  }

  private noteEpoch(node: string, epoch: string): void {
    const list = this.epochs.get(node) ?? [];
    const at = list.indexOf(epoch);
    if (at >= 0) list.splice(at, 1);
    list.push(epoch);
    this.epochs.set(node, list);
  }

  private markSeq(node: string, epoch: string, seq: number): void {
    const key = `${node}/${epoch}`;
    let set = this.seqs.get(key);
    if (!set) this.seqs.set(key, (set = new Set()));
    set.add(seq);
    let c = this.contiguous.get(key) ?? 0;
    while (set.has(c + 1)) c++;
    this.contiguous.set(key, c);
    this.noteEpoch(node, epoch);
  }

  apply(row: EventRow): void {
    const m = row.meta as Record<string, unknown>;
    if (row.kind === ALERT_SENT || row.kind === ALERT_SKIPPED) {
      this.due.delete(Number(m.source_event));
      return;
    }
    if (row.kind === ALERT_FAILED) {
      const d = this.due.get(Number(m.source_event));
      if (d) d.failed = true;
      return;
    }
    if (row.kind === EPOCH_RESET) {
      this.noteEpoch(row.actor, String(m.new_epoch));
      return;
    }
    if (!row.kind.startsWith(EV_PREFIX)) return;
    const node = row.actor;
    const epoch = String(m.epoch ?? "legacy");
    this.markSeq(node, epoch, Number(m.seq));
    if (row.kind === REJECTED_KIND) {
      this.rejections.set(`${node}/${epoch}/${Number(m.seq)}`, String(m.rule ?? "rejected"));
      return;
    }
    this.events++;
    const kind = row.kind.slice(EV_PREFIX.length) as NodeEvent["kind"];
    const rec = this.nodes.get(node) ?? { lastEvent: row.ts, lastHeartbeat: null };
    rec.lastEvent = row.ts;
    if (kind === "node.heartbeat") rec.lastHeartbeat = row.ts;
    this.nodes.set(node, rec);

    const a = m.agent as HubAgent | null;
    const state = (m.state as string | null) ?? null;
    if (a && (kind === "agent.seen" || kind === "agent.state" || kind === "agent.gone" || kind === "lane.done" || kind === "alert")) {
      const prev = this.agents.get(a.id);
      const next: AgentRec = {
        ...(prev ?? { ...a, node, state: null, reason: null, stateSince: null }),
        id: a.id,
        kind: a.kind,
        pane: a.pane,
        lane: a.lane ?? prev?.lane ?? null,
        model: a.model ?? prev?.model ?? null,
        runtime: a.runtime,
        pid: a.pid,
        node,
        lastSeen: row.ts,
      };
      let newState: string | null = null;
      if (kind === "agent.gone") newState = "offline";
      else if (kind === "lane.done") newState = "finished";
      else if (kind !== "alert") newState = state;
      if ((kind === "agent.state" || kind === "agent.seen") && newState && ALERT_STATES.has(newState) && newState !== (prev?.state ?? null)) {
        this.due.set(row.id, { sourceEvent: row.id, node, agent: a.id, lane: next.lane, state: newState, reason: (m.reason as string | null) ?? null, failed: false });
      }
      if (newState && newState !== next.state) {
        next.state = newState;
        next.stateSince = row.ts;
      }
      if (newState) next.reason = (m.reason as string | null) ?? null;
      this.agents.set(a.id, next);
      if (kind === "lane.done" && next.lane) this.laneDone.set(next.lane, row.ts);
    } else if (kind === "lane.done" && m.meta && typeof (m.meta as Record<string, unknown>).lane === "string") {
      this.laneDone.set(String((m.meta as Record<string, unknown>).lane), row.ts);
    }
  }

  private nodeStale(node: string, nowMs: number): boolean {
    const rec = this.nodes.get(node);
    if (!rec) return true;
    return nowMs - Date.parse(rec.lastHeartbeat ?? rec.lastEvent) > OFFLINE_AFTER_MS;
  }

  agentViews(nowMs: number, filter: { node?: string } = {}): AgentView[] {
    const out: AgentView[] = [];
    for (const rec of this.agents.values()) {
      if (filter.node && rec.node !== filter.node) continue;
      const stale = this.nodeStale(rec.node, nowMs);
      out.push({ ...rec, state: stale ? "offline" : rec.state, stale });
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  laneViews(nowMs: number, state?: string): Array<{ lane: string; state: string; agents: string[]; done_at: string | null }> {
    const byLane = new Map<string, AgentView[]>();
    for (const v of this.agentViews(nowMs)) {
      if (!v.lane) continue;
      byLane.set(v.lane, [...(byLane.get(v.lane) ?? []), v]);
    }
    for (const lane of this.laneDone.keys()) if (!byLane.has(lane)) byLane.set(lane, []);
    const out = [...byLane.entries()].map(([lane, list]) => {
      const done = this.laneDone.get(lane) ?? null;
      const states = list.map((v) => v.state ?? "idle");
      const best = done ? "finished" : (LANE_RANK.find((s) => states.includes(s)) ?? "idle");
      return { lane, state: best, agents: list.map((v) => v.id), done_at: done };
    });
    return out.filter((l) => !state || l.state === state).sort((a, b) => (a.lane < b.lane ? -1 : 1));
  }

  nodeSeen(): Record<string, { last_event: string; last_heartbeat: string | null; ack_seq: number; epoch: string | null }> {
    const out: Record<string, { last_event: string; last_heartbeat: string | null; ack_seq: number; epoch: string | null }> = {};
    for (const [node, rec] of [...this.nodes.entries()].sort()) out[node] = { last_event: rec.lastEvent, last_heartbeat: rec.lastHeartbeat, ack_seq: this.ackSeq(node, this.currentEpoch(node) ?? ""), epoch: this.currentEpoch(node) };
    return out;
  }
}
