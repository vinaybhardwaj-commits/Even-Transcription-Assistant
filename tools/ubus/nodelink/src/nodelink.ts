import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { classifyTail, inferRuntime, normaliseTail } from "./classify.js";
import type { NodelinkConfig } from "./config.js";
import type { Spool } from "./spool.js";
import type { Transport } from "./transport.js";
import type { AgentKind, AgentRef, AgentState, Clock, EventKind, LaneRow, Logger, NodeEvent, PaneInfo, ProcInfo, Sources } from "./types.js";

const AGENT_COMM = /^(claude|opencode|codex)/;
const MISSED_FOR_OFFLINE = 3;
const RELAUNCH_COOLDOWN_MS = 10 * 60_000;
/** CPU busy threshold over one scan interval when herdr has no status (ms of CPU). */
const CPU_BUSY_MS = 100;

interface Tracked {
  ref: AgentRef;
  cwd: string | null;
  isLane: boolean;
  state: AgentState | null;
  reason: string | null;
  startMs: number;
  missed: number;
  everRunning: boolean;
  tailHash: string;
  lastOutputMs: number;
  lastFileMs: number;
  lastCpuMs: number | null;
  doneEmitted: boolean;
  lastRelaunchMs: number;
}

export interface AgentRow {
  id: string;
  kind: AgentKind;
  pane: string | null;
  lane: string | null;
  runtime: string;
  state: AgentState | null;
  reason: string | null;
  pid: number | null;
}

const sanitize = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";

export class NodeLink {
  private readonly agents = new Map<string, Tracked>();
  private connected = true;
  private everFlushed = false;
  private failures = 0;
  private retryAt = 0;
  private flushing = false;
  private readonly lastFlushWarn = new Map<string, number>();

  constructor(
    private readonly cfg: NodelinkConfig,
    private readonly src: Sources,
    private readonly spool: Spool,
    private readonly transport: Transport,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  private herdrMissing = false;
  private herdrWasMissing = false;

  private emit(kind: EventKind, agent: AgentRef | null, state: AgentState | null, reason: string | null, meta: NodeEvent["meta"] = {}): void {
    this.spool.enqueue((seq, epoch) => ({ v: 1, node: this.cfg.node, seq, epoch, ts: new Date(this.clock.now()).toISOString(), kind, agent: agent ? { ...agent } : null, state, reason, meta }));
  }

  // ---- discovery ----------------------------------------------------------

  scanOnce(): void {
    const now = this.clock.now();
    const procs = this.src.procs().filter((p) => AGENT_COMM.test(p.comm));
    const panes = this.src.panes();
    this.herdrMissing = this.src.herdrMissing?.() ?? false;
    // scanOnce runs once per interval, so this is one error per interval
    if (this.herdrMissing) (this.log.error ?? this.log.warn).call(this.log, `herdr executable not found or unusable (${this.cfg.herdrBin}); reporting no panes`);
    if (this.herdrMissing !== this.herdrWasMissing) {
      this.herdrWasMissing = this.herdrMissing;
      this.emit("alert", null, null, this.herdrMissing ? "herdr_missing" : "herdr_recovered");
    }
    const lanes = this.src.lanes().filter((l) => this.laneOnThisNode(l));
    const seen = new Set<string>();
    const usedProcs = new Set<number>();
    const usedPanes = new Set<string>();

    const takeProc = (cwd: string | null): ProcInfo | null => {
      if (!cwd) return null;
      const p = procs.find((x) => !usedProcs.has(x.pid) && x.cwd === cwd);
      if (p) usedProcs.add(p.pid);
      return p ?? null;
    };

    for (const row of lanes) {
      const pane = this.paneForLane(row, panes);
      const known = this.agents.get(this.idFor(row.lane));
      if (!pane && !known) continue; // historic lane row with no live pane
      if (pane) usedPanes.add(pane.session + "/" + pane.paneId);
      const proc = takeProc(pane?.cwd ?? known?.cwd ?? null);
      this.update(row.lane, row, pane ?? null, proc, now);
      seen.add(this.idFor(row.lane));
    }
    for (const proc of procs) {
      if (usedProcs.has(proc.pid)) continue;
      const pane = panes.find((p) => !usedPanes.has(p.session + "/" + p.paneId) && p.cwd && p.cwd === proc.cwd) ?? null;
      if (pane) usedPanes.add(pane.session + "/" + pane.paneId);
      usedProcs.add(proc.pid);
      let name = sanitize(proc.cwd ? basename(proc.cwd) : proc.comm);
      if (seen.has(this.idFor(name))) name = `${name}-${proc.pid}`;
      this.update(name, null, pane, proc, now);
      seen.add(this.idFor(name));
    }
    for (const pane of panes) {
      const key = pane.session + "/" + pane.paneId;
      if (usedPanes.has(key) || pane.agentStatus === "unknown" || pane.agentStatus === "") continue;
      const name = sanitize(`${pane.session}-${pane.paneId}`);
      this.update(name, null, pane, null, now);
      seen.add(this.idFor(name));
    }
    for (const [id, t] of this.agents) if (!seen.has(id)) this.missing(t, now);
    this.writeState();
  }

  private idFor(name: string): string {
    return `${name}@${this.cfg.node}`;
  }

  /** Match by (session, paneId). lanes.tsv has no session, so prefer cfg.laneSession over the first same-id pane. */
  private paneForLane(row: LaneRow, panes: PaneInfo[]): PaneInfo | undefined {
    const same = panes.filter((p) => p.paneId === row.pane);
    const want = row.session ?? this.cfg.laneSession;
    return same.find((p) => p.session === want) ?? (row.session ? undefined : same.length === 1 ? same[0] : undefined);
  }

  private laneOnThisNode(l: LaneRow): boolean {
    const h = l.host.toLowerCase();
    return h === this.cfg.node || this.cfg.hostAliases[h] === this.cfg.node;
  }

  private update(name: string, lane: LaneRow | null, pane: PaneInfo | null, proc: ProcInfo | null, now: number): void {
    const id = this.idFor(name);
    let t = this.agents.get(id);
    const kind: AgentKind = proc ? (proc.comm.startsWith("claude") ? "claude-code" : proc.comm.startsWith("opencode") ? "opencode" : "codex") : t?.ref.kind ?? "herdr-pane";
    const rt = proc ? inferRuntime(proc.args, proc.bedrockEnv, proc.comm, lane?.model ?? null) : null;
    const isNew = !t;
    if (!t) {
      t = {
        ref: { id, kind, pane: pane?.paneId ?? lane?.pane ?? null, lane: lane?.lane ?? null, model: lane?.model ?? null, runtime: "unknown", pid: null },
        cwd: pane?.cwd ?? proc?.cwd ?? null,
        isLane: !!lane,
        state: null,
        reason: null,
        startMs: proc?.startMs ?? lane?.startMs ?? now,
        missed: 0,
        everRunning: false,
        tailHash: "",
        lastOutputMs: now,
        lastFileMs: now,
        lastCpuMs: null,
        doneEmitted: false,
        lastRelaunchMs: 0,
      };
      this.agents.set(id, t);
    }
    t.missed = 0;
    if (pane) {
      t.ref.pane = pane.paneId;
      t.cwd = pane.cwd ?? t.cwd;
    }
    if (proc) {
      t.everRunning = true;
      t.ref.pid = proc.pid;
      t.ref.kind = kind;
      if (rt) {
        t.ref.runtime = rt.runtime;
        t.ref.model = rt.model ?? t.ref.model;
      }
      t.cwd = t.cwd ?? proc.cwd;
    } else {
      t.ref.pid = null;
    }
    if (isNew) this.emit("agent.seen", t.ref, null, null);

    // output / file change tracking
    const tail = pane ? this.safeTail(pane) : "";
    if (pane) {
      const h = createHash("sha1").update(normaliseTail(tail)).digest("hex");
      if (h !== t.tailHash) {
        if (t.tailHash !== "") t.lastOutputMs = now;
        t.tailHash = h;
      }
    }
    if (t.cwd) {
      const m = this.src.worktreeMtime(t.cwd);
      if (m === "unknown") t.lastFileMs = now; // scan was capped: do not guess a stall from files
      else if (m !== null && m > t.lastFileMs) t.lastFileMs = m;
    }
    let cpuBusy = false;
    if (proc) {
      if (t.lastCpuMs !== null && proc.cpuMs - t.lastCpuMs >= CPU_BUSY_MS) cpuBusy = true;
      t.lastCpuMs = proc.cpuMs;
    }

    const [state, reason] = this.decide(t, pane, proc, tail, cpuBusy, now);
    this.setState(t, state, reason, now);
  }

  private decide(t: Tracked, pane: PaneInfo | null, proc: ProcInfo | null, tail: string, cpuBusy: boolean, now: number): [AgentState, string | null] {
    if (t.isLane && t.ref.lane && t.cwd) {
      const done = this.src.doneMtime(t.cwd, t.ref.lane);
      if (done !== null && done > t.startMs) return ["finished", "done_marker"];
    }
    if (!proc && t.isLane && t.everRunning) return ["errored", "proc_exited"];
    if (pane) {
      const rule = classifyTail(tail);
      if (rule) return ["errored", rule];
    }
    const status = pane?.agentStatus;
    let base: AgentState;
    if (status === "working") base = "working";
    else if (status === "idle" || status === "blocked" || status === "done") base = "idle";
    else base = cpuBusy ? "working" : "idle";
    if (base === "working" && now - Math.max(t.lastOutputMs, t.lastFileMs) >= this.cfg.stallMs) return ["stalled", "no_activity"];
    return [base, null];
  }

  private missing(t: Tracked, now: number): void {
    t.missed++;
    if (t.isLane && t.ref.lane && t.cwd && t.state !== "finished") {
      const done = this.src.doneMtime(t.cwd, t.ref.lane);
      if (done !== null && done > t.startMs) return this.setState(t, "finished", "done_marker", now);
    }
    if (t.isLane && t.everRunning && t.state !== "errored" && t.state !== "finished" && t.state !== "offline") {
      t.ref.pid = null;
      return this.setState(t, "errored", "proc_exited", now);
    }
    if (t.missed >= MISSED_FOR_OFFLINE && t.state !== "offline" && t.state !== "errored") {
      this.setState(t, "offline", null, now);
      this.emit("agent.gone", t.ref, "offline", null);
    }
  }

  private setState(t: Tracked, state: AgentState, reason: string | null, now: number): void {
    const changed = t.state !== state || t.reason !== reason;
    if (!changed) return;
    const prev = t.state;
    t.state = state;
    t.reason = reason;
    this.emit("agent.state", t.ref, state, reason, { prev: prev ?? "none" });
    if (state === "finished" && !t.doneEmitted) {
      t.doneEmitted = true;
      this.emit("lane.done", t.ref, state, reason);
    }
    if (state === "errored" || state === "stalled") {
      this.emit("alert", t.ref, state, reason);
      this.log.warn(`alert ${t.ref.id} ${state} ${reason ?? ""}`.trim());
      this.maybeRelaunch(t, now);
    }
  }

  private maybeRelaunch(t: Tracked, now: number): void {
    const lane = t.ref.lane;
    if (!lane || !this.cfg.lanePolicy[lane]?.auto_relaunch) return;
    if (now - t.lastRelaunchMs < RELAUNCH_COOLDOWN_MS) return;
    t.lastRelaunchMs = now;
    try {
      this.src.relaunch?.(lane);
      this.log.info(`relaunch requested ${lane}`);
    } catch {
      this.log.warn(`relaunch failed ${lane}`);
    }
  }

  private safeTail(pane: PaneInfo): string {
    try {
      return this.src.paneTail(pane, 40);
    } catch {
      return "";
    }
  }

  // ---- heartbeat ----------------------------------------------------------

  heartbeatOnce(): void {
    const count = (s: AgentState) => [...this.agents.values()].filter((t) => t.state === s).length;
    this.emit("node.heartbeat", null, null, null, {
      agents: this.agents.size,
      working: count("working"),
      idle: count("idle"),
      stalled: count("stalled"),
      errored: count("errored"),
      spool_depth: this.spool.stats().depth,
    });
  }

  // ---- spool flush --------------------------------------------------------

  /** Send queued events in order. Returns true when the spool is drained. */
  async flushOnce(): Promise<boolean> {
    if (this.flushing) return false;
    this.flushing = true;
    try {
      return await this.flushLoop();
    } finally {
      this.flushing = false;
    }
  }

  private async flushLoop(): Promise<boolean> {
    // backoff never exceeds 60 s; a larger gap means the wall clock stepped back
    if (this.retryAt - this.clock.now() > 60_000) this.retryAt = 0;
    if (this.clock.now() < this.retryAt) return false;
    for (;;) {
      const batch = this.spool.pending(500);
      if (batch.length === 0) {
        await this.afterContact();
        return true;
      }
      try {
        const { ack_seq, rejected } = await this.transport.postEvents(batch);
        this.handleRejected(batch, rejected ?? []);
        // never trust an ack beyond what we sent
        this.spool.ack(Math.min(ack_seq, batch[batch.length - 1].seq), batch[0].epoch);
        const next = this.spool.pending(1)[0];
        if (next && next.seq === batch[0].seq && next.epoch === batch[0].epoch) {
          this.log.warn("hub made no progress on ack");
          return false;
        }
      } catch (err) {
        this.connected = false;
        this.failures++;
        this.retryAt = this.clock.now() + Math.min(2 ** this.failures * 1000, 60_000);
        this.warnFlush(err);
        return false;
      }
    }
  }

  /** One warn per minute per distinct failure; carries the HTTP status (never headers, bodies or keys). */
  private warnFlush(err: unknown): void {
    const m = /^hub status (\d{3})$/.exec((err as Error)?.message ?? "");
    const what = m ? `status ${m[1]}` : /^hub reply without ack_seq$/.test((err as Error)?.message ?? "") ? "bad reply" : "network error";
    const now = this.clock.now();
    if (now - (this.lastFlushWarn.get(what) ?? -Infinity) < 60_000) return;
    this.lastFlushWarn.set(what, now);
    this.log.warn(`flush failed: ${what} (spool depth ${this.spool.stats().depth})`);
  }

  /** A rejected event is dead: recorded with its rule id, alerted once, never resent, so it cannot stall the queue. */
  private handleRejected(batch: NodeEvent[], rejected: Array<{ seq: number; rule: string }>): void {
    const done = new Set<number>();
    for (const { seq, rule } of rejected) {
      if (done.has(seq)) continue;
      done.add(seq);
      const ev = batch.find((e) => e.seq === seq);
      if (!ev) continue;
      this.spool.markDead(seq, ev.epoch, rule);
      this.log.warn(`hub rejected seq=${seq} rule=${rule}`);
      // never alert about a rejected alert: that could loop
      if (ev.kind === "alert" && ev.reason === "hub_rejected") continue;
      this.emit("alert", null, null, "hub_rejected", { dead_seq: seq, dead_kind: ev.kind, rule });
    }
  }

  /** After the first contact and after each reconnect: pull what the hub logged while we were away. */
  private async afterContact(): Promise<void> {
    if (this.connected && this.everFlushed) return;
    this.connected = true;
    this.failures = 0;
    this.retryAt = 0;
    this.everFlushed = true;
    try {
      let cursor = this.spool.cursor();
      for (let page = 0; page < 10; page++) {
        const r = await this.transport.since(cursor, 1000);
        for (const ev of r.events) if (typeof ev.id === "string") this.spool.cacheInbound(ev.id, ev);
        const next = r.next_cursor === null || r.next_cursor === undefined ? null : String(r.next_cursor);
        if (!next || next === cursor) break;
        cursor = next;
        this.spool.setCursor(cursor);
      }
    } catch {
      this.connected = false;
      this.failures++;
      this.retryAt = this.clock.now() + Math.min(2 ** this.failures * 1000, 60_000);
    }
  }

  // ---- state snapshot for the CLI ----------------------------------------

  table(): AgentRow[] {
    return [...this.agents.values()].map((t) => ({
      id: t.ref.id, kind: t.ref.kind, pane: t.ref.pane, lane: t.ref.lane, runtime: t.ref.runtime, state: t.state, reason: t.reason, pid: t.ref.pid,
    }));
  }

  private writeState(): void {
    try {
      mkdirSync(dirname(this.cfg.stateFile), { recursive: true });
      const tmp = `${this.cfg.stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ node: this.cfg.node, ts: new Date(this.clock.now()).toISOString(), herdr_missing: this.herdrMissing, agents: this.table() }), { mode: 0o600 });
      renameSync(tmp, this.cfg.stateFile);
    } catch {
      this.log.warn("state file write failed");
    }
  }

  start(): () => void {
    const run = (fn: () => void | Promise<unknown>) => () => {
      Promise.resolve()
        .then(fn)
        .catch(() => this.log.warn("tick failed"));
    };
    const timers = [
      setInterval(run(() => this.scanOnce()), this.cfg.scanIntervalMs),
      setInterval(run(() => this.heartbeatOnce()), this.cfg.heartbeatIntervalMs),
      setInterval(run(() => this.flushOnce()), this.cfg.flushIntervalMs),
    ];
    run(() => this.scanOnce())();
    run(() => this.heartbeatOnce())();
    return () => timers.forEach(clearInterval);
  }
}
