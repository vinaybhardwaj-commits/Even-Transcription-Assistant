import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  addressDenied,
  displayLabel,
  extractToTag,
  forPaneTag,
  formatAddress,
  isGrokHandle,
  originTag,
  parseAddress,
  validHandle,
  validMachine,
  validRuntime,
} from "./address.js";
import type { Archive, ArchiveAlert } from "./archive.js";
import type { EtaAdapter, EtaPost, HandoffAdapter, HerdrAdapter, HerdrAgent, OpenBotAdapter } from "./adapters.js";
import type { UbusConfig } from "./config.js";
import {
  BRIDGE_IDENTITY,
  DESTRUCTIVE_TOOLS,
  ETA_BODY_MAX_BYTES,
  ETA_LEADS,
  FILTER_ID,
  ARCHIVE_AFTER_GONE_MS,
  BINDING_TTL_MS,
  GONE_MS,
  PANE_ID_RE,
  STALE_GONE_MS,
  GRANT_VERBS,
  HOUR_MS,
  IDEMPOTENCY_MS,
  LIAISON_IDENTITY,
  LIVE_MS,
  NUDGE_GAP_MS,
  SCHEMA_MSG,
  STATELESS_PLATFORM_CLASSES,
  WAKE_GAP_MS,
  isDeniedMachine,
} from "./constants.js";
import { Escalator, STEWARD } from "./escalate.js";
import { filterFields, filterFieldsSecretsOnly, filterPath, filterText } from "./filter.js";
import type { AgentRow, MessageRow, Store } from "./store.js";
import { num as rowNum, str as rowStr } from "./sqlite.js";
import { asBool, asNumber, compareVersions, asObject, asString, bytesLen, canonical, clamp, id, istStamp, sha256, type Clock } from "./util.js";
import { openHub, v3Enabled, type Hub } from "./v3/hub.js";

/** A shim's claim on a handle lapses when the connection has made no call for this long. */
const CLAIM_IDLE_MS = LIVE_MS;

export interface Caller {
  handle?: string;
  machine: string;
  machineVerified: boolean;
  via: "tailnet" | "cloudflare" | "stdio" | "local";
  platformClass?: string;
  /** x-ubus-client, when the door sent one. */
  client?: string;
  userAgent?: string;
  remote?: string;
  /** Owner of the connection: the shim's x-ubus-instance, else the MCP session id. A handle registered on one transport may only be spoken for by that transport. */
  sessionId?: string;
  /** Set by bindCaller when `from` names a handle this transport does not own; call() answers from_not_owned. */
  fromRefused?: string;
}

export interface ToolResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export const NOT_REGISTERED_HINT = "call ubus_register with {handle, machine}; session is optional";

export function notRegistered(): BusError {
  return new BusError("not_registered", NOT_REGISTERED_HINT);
}

export class BusError extends Error {
  constructor(
    public code: string,
    message?: string,
    /** Filter rule id. Never the matched text. */
    public rule?: string,
  ) {
    super(message ?? code);
  }
}

const INBOX = new Set(["stored", "stored_poll", "hook_pending", "nudged", "lead_routed"]);
const REDACTED = "[redacted: internal-scope]";
const LEADS: ReadonlySet<string> = new Set(ETA_LEADS);

type Plan =
  | { kind: "inbox"; handle: string }
  | { kind: "lead"; lead: string; pane: string; leadLive: boolean }
  | { kind: "eta"; to: string; forPane: string }
  | { kind: "openbot"; handle: string }
  | { kind: "unknown" };

interface GroupDef {
  members?: string[];
  dynamic?: "grok" | "panes" | "all";
  machine?: string;
  owner_gated_grok?: boolean;
  restricted?: boolean;
}

export class Ubus {
  private waiters = new Map<string, Array<() => void>>();
  private corrWaiters = new Map<string, Array<() => void>>();
  private groupsMtime = 0;
  private groups: Record<string, GroupDef> = {};
  private timer: NodeJS.Timeout | null = null;
  private alerting = false;
  /** machine/name of panes herdr reports live. Refreshed each sweep; such panes never expire to gone. */
  private herdrLive = new Set<string>();
  /** ubus v3 hub, opened only when UBUS_V3=1. P0 routes ubus_send/ubus_inbox through it. */
  private v3hub: Hub | null = null;

  constructor(
    readonly config: UbusConfig,
    readonly store: Store,
    readonly archive: Archive,
    readonly eta: EtaAdapter,
    readonly herdr: HerdrAdapter,
    readonly openbot: OpenBotAdapter,
    readonly handoff: HandoffAdapter,
    private clock: Clock,
    private loadGroups: () => { defs: Record<string, GroupDef>; mtime: number },
  ) {
    this.ensureSystem();
    this.escalator = new Escalator({
      config,
      store,
      herdr,
      clock,
      presenceOf: (a) => this.presenceOf(a),
      isSystem,
      send: (to, subject, body, scope) => this.systemSend(to, subject, body, STEWARD, scope),
      isExternal: (handle) => {
        const a = this.store.getAgent(handle);
        return !!a && this.isExternalAgent(a);
      },
    });
  }

  private escalator: Escalator;

  /** A delivery with no message row can never be read. Mark it read with a reason, log once, never delete. */
  private markOrphans(): void {
    const orphans = this.store.orphanDeliveries();
    if (!orphans.length) return;
    const ts = this.clock.iso();
    for (const o of orphans) this.store.markOrphanRead(o.id, ts, "orphan:no_message");
    try {
      this.archive.append({
        src: "ubus",
        event: "orphan_delivery",
        essential: false,
        rec: { count: orphans.length, deliveries: orphans.slice(0, 50).map((o) => ({ id: o.id, message_id: o.messageId, to: o.toHandle })) },
      });
    } catch {
      /* logging must not stop the sweep */
    }
  }

  orphanCount(): number {
    return this.store.orphanMarkedCount();
  }

  /** For /health. */
  escalationStatus(): { enabled: boolean; last_hour: Record<string, number> } {
    return this.escalator.status();
  }

  startTimers(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.sweep();
        this.pollEta();
        this.archive.seal();
        this.archive.flush();
      } catch {
        /* timer must not crash the process */
      }
    }, this.config.tickMs);
    this.timer.unref?.();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    for (const list of this.waiters.values()) for (const fn of list) fn();
    for (const list of this.corrWaiters.values()) for (const fn of list) fn();
    this.waiters.clear();
    this.corrWaiters.clear();
    if (this.v3hub) {
      this.v3hub.close();
      this.v3hub = null;
    }
    this.store.close();
    const eta = this.eta as { close?: () => void };
    eta.close?.();
  }

  sweep(): void {
    try {
      this.herdrLive = new Set(this.herdr.listAgents().map((a) => `${a.machine}/${a.name}`));
    } catch {
      /* keep the previous set */
    }
    this.reapPresence();
    this.expireRequests();
    this.flushDigests();
    this.flushNotRegisteredWindows();
    this.archiveGone();
    this.markOrphans();
    try {
      this.escalator.sweep();
    } catch {
      /* the escalation pass must not stop the rest of the sweep */
    }
    this.store.pruneBindings(new Date(this.clock.now() - BINDING_TTL_MS).toISOString());
  }

  /** Persist and look up mcp-session-id bindings so a server restart does not orphan connected clients. */
  bindSession(sessionId: string, b: { handle: string; machine: string; via: string; platformClass?: string }): void {
    this.store.upsertBinding({ sessionId, handle: b.handle, machine: b.machine, via: b.via, platformClass: b.platformClass ?? "" }, this.clock.iso());
  }

  touchBinding(sessionId: string): void {
    this.store.touchBinding(sessionId, this.clock.iso());
  }

  /** The stored binding, only while its agent row exists and is not closed. */
  lookupBinding(sessionId: string): { handle: string; machine: string; via: string; platformClass: string } | undefined {
    const b = this.store.getBinding(sessionId);
    if (!b) return undefined;
    const agent = this.store.getAgent(b.handle);
    if (!agent || agent.closed) return undefined;
    return b;
  }

  /** Time the row became gone, as ms since epoch. */
  private goneSince(agent: AgentRow): number {
    const beat = Date.parse(agent.lastHeartbeatAt || agent.registeredAt);
    const base = Number.isFinite(beat) ? beat : this.clock.now();
    if (agent.closed) return base;
    if (agent.runtime === "grok" || agent.runtime === "cowork") return base + GONE_MS;
    return base + STALE_GONE_MS;
  }

  /** V's rule: no hard deletes. Rows gone for over 24h move to agents_archive. */
  private archiveGone(): number {
    let n = 0;
    const ts = this.clock.iso();
    for (const agent of this.store.listAgents()) {
      if (agent.handle === "ubus" || isSystem(agent)) continue;
      if (this.presenceOf(agent) !== "gone") continue;
      if (this.clock.now() - this.goneSince(agent) < ARCHIVE_AFTER_GONE_MS) continue;
      if (this.store.archiveAgent(agent.handle, ts)) {
        n += 1;
        this.logPresence(agent, "archive");
      }
    }
    return n;
  }

  async call(tool: string, rawArgs: unknown, caller: Caller): Promise<ToolResult> {
    const args = asObject(rawArgs);
    if (caller.sessionId) {
      this.transportSeen.set(caller.sessionId, this.clock.now());
      this.pruneSeen(this.clock.now());
    }
    const bound = this.bindCaller(tool, args, caller);
    let result: ToolResult = { ok: false, error: "internal" };
    try {
      if (this.paused() && tool !== "ubus_whoami" && tool !== "ubus_inbox") {
        result = { ok: false, error: "paused" };
      } else if (bound.fromRefused) {
        result = { ok: false, error: "from_not_owned", message: `from ${bound.fromRefused} is not registered by this connection; register it here first` };
      } else {
        result = await this.dispatch(tool, args, bound);
      }
    } catch (err) {
      if (err instanceof BusError) {
        result = { ok: false, error: err.code, message: err.message };
        if (err.rule) result.rule = err.rule;
      } else result = { ok: false, error: "internal" };
    }
    this.writeAudit(tool, bound, args, result);
    return result;
  }

  /**
   * Stateless MCP clients drop Mcp-Session-Id between calls (D1 labels).
   * When this HTTP session has no registration, accept handle, from, or machine+runtime+session
   * and resolve them against the directory. Register itself is unchanged.
   * grok-platform, cursor-cloud, and fleet-cloud may only resume a handle registered under that same class.
   */
  bindCaller(tool: string, args: Record<string, unknown>, caller: Caller): Caller {
    if (tool === "ubus_register") return caller;
    if (caller.handle) return this.bindFrom(args, caller);
    const hint = identityHint(args);
    const agent = this.agentForHint(hint);
    if (!agent || agent.closed || agent.presence === "gone") return caller;
    if (!classAllowsResume(caller.platformClass, agent.platformClass)) return caller;
    // A handle another live shim holds (or any secondary claim) cannot be taken by naming it. Unheld handles resolve as before.
    if (this.heldByOther(agent.handle, caller.sessionId)) return { ...caller, fromRefused: agent.handle };
    const machine = caller.machineVerified && caller.machine && caller.machine !== "unknown" ? caller.machine : agent.machine;
    return { ...caller, handle: agent.handle, machine };
  }

  /**
   * A connection that already has a handle (the stdio shim's default) may speak for other handles
   * only if it registered them itself (this.claims). One shim can then carry several Cowork sessions,
   * each calling ubus_register for its own handle and passing `from`. A handle owned by another
   * connection, or not registered, is refused, never silently sent under the shim's default label.
   */
  private bindFrom(args: Record<string, unknown>, caller: Caller): Caller {
    const from = args.from;
    const named = typeof from === "string" ? from : from && typeof from === "object" && !Array.isArray(from) ? asString((from as Record<string, unknown>).handle) : "";
    if (!named || named === caller.handle) return caller;
    const agent = this.store.getAgent(named);
    if (!caller.sessionId || !agent || agent.closed || agent.presence === "gone" || this.claimOwner(agent.handle) !== caller.sessionId) {
      return { ...caller, fromRefused: named };
    }
    return { ...caller, handle: agent.handle };
  }

  private agentForHint(hint: IdentityHint): AgentRow | undefined {
    if (hint.handle) {
      const byHandle = this.store.getAgent(hint.handle);
      if (byHandle && !byHandle.closed && byHandle.presence !== "gone") return byHandle;
    }
    if (hint.machine && hint.runtime && hint.session) {
      const bySession = this.store.getAgentBySession(hint.machine.toLowerCase(), hint.runtime, hint.session);
      if (bySession && !bySession.closed && bySession.presence !== "gone") return bySession;
    }
    return undefined;
  }

  /** Hook/shim summary: counts, ids, handles. No subjects or bodies. */
  unreadSummary(handle: string): { count: number; ids: string[]; from: string[] } {
    const summary = this.store.unreadIds(handle, 20);
    return { count: this.store.unreadCount(handle), ids: summary.ids, from: summary.from };
  }

  pollEta(): number {
    let rows: EtaPost[] = [];
    try {
      rows = this.eta.tail(this.store.etaCursor());
    } catch {
      return 0;
    }
    let n = 0;
    let max = this.store.etaCursor();
    for (const row of rows) {
      if (compareId(row.id, max) > 0) max = row.id;
      if (this.store.seenEta(row.id)) continue;
      this.store.markEtaSeen(row.id);
      if (this.ingestEta(row)) n += 1;
    }
    this.store.setEtaCursor(max);
    return n;
  }

  private async dispatch(tool: string, args: Record<string, unknown>, caller: Caller): Promise<ToolResult> {
    switch (tool) {
      case "ubus_register":
        this.checkClaim(args, caller);
        return this.claim(this.register(args, caller), caller);
      case "ubus_heartbeat":
        return this.heartbeat(caller);
      case "ubus_unregister":
        return this.unregister(caller);
      case "ubus_whoami":
        return this.whoami(caller);
      case "ubus_directory":
        return this.directory(args);
      case "ubus_resolve":
        return this.resolve(args);
      case "ubus_groups":
        return this.groupsTool();
      case "ubus_send":
        if (v3Enabled()) return this.hub().send(args, caller);
        return this.send(args, caller, "msg");
      case "ubus_reply":
        return this.reply(args, caller);
      case "ubus_inbox":
        if (v3Enabled()) return this.hub().inbox(args, caller);
        return this.inbox(args, caller);
      case "ubus_wait":
        return this.wait(args, caller);
      case "ubus_thread":
        return this.thread(args, caller);
      case "ubus_ack":
        if (v3Enabled()) return this.ackViaV3(args, caller);
        return this.ack(args, caller);
      case "ubus_request":
        return this.request(args, caller);
      case "ubus_await":
        return this.awaitReq(args, caller);
      case "ubus_requests":
        return this.requests(args, caller);
      case "ubus_escalate":
        return this.escalate(args, caller);
      case "ubus_broadcast":
        return this.broadcast(args, caller);
      case "ubus_handoff":
        return this.doHandoff(args, caller);
      case "ubus_grant":
        return this.grant(args, caller);
      case "ubus_approval_request":
        return this.approvalRequest(args, caller);
      case "ubus_approve":
        return this.approve(args, caller);
      case "ubus_agent_send":
        return this.agentSend(args, caller);
      case "ubus_ask":
        return this.ask(args, caller);
      case "ubus_agent_tag":
        return this.grantVerb(args, caller, "tag", "ubus_agent_tag");
      case "ubus_agent_compact":
        return this.grantVerb(args, caller, "compact", "ubus_agent_compact");
      case "ubus_agent_set_model":
        return this.grantVerb(args, caller, "set_model", "ubus_agent_set_model");
      case "ubus_agent_interrupt":
      case "ubus_agent_spawn":
      case "ubus_agent_restart":
      case "ubus_agent_kill":
      case "ubus_agent_clear":
        return this.destructive(tool, args, caller);
      case "ubus_agent_sessions":
        return this.agentSessions(args);
      case "ubus_agent_status":
        return this.agentStatus(args);
      case "ubus_agent_read":
        return this.agentRead(args, caller);
      default:
        return { ok: false, error: "unknown_tool", tool };
    }
  }

  private paused(): boolean {
    return existsSync(this.config.stopFile);
  }

  /**
   * ubus_ack under UBUS_V3=1: v3 answers for its own ids; ids it does not know
   * (reply/request/ETA mail written by v1) fall through to the v1 store so an
   * ack never silently misses older mail.
   */
  private ackViaV3(args: Record<string, unknown>, caller: Caller): ToolResult {
    // One note check over the union of rules, before either store is written:
    // v1's size cap and secret rules (with its audit row) here, the v3 PHI
    // filter (allow-list aware) inside ackTool.
    const note = asString(args.note);
    if (note && caller.handle) this.assertText(this.requireSender(caller), "ack", note, "ubus_ack", undefined, false, "", true);
    const res = this.hub().ackTool(args, caller);
    if (!res.ok) return res;
    const acked = Array.isArray(res.acked) ? res.acked.map(String) : [];
    const missing = Array.isArray(res.missing) ? res.missing.map(String) : [];
    const unknown = Array.isArray(res.unknown) ? res.unknown.map(String) : [];
    if (!unknown.length) return { ok: true, acked, missing };
    // The v3 leg already checked the note (allow-list aware); v1 must not re-judge it.
    const legacy = this.ack({ ...args, ids: unknown }, caller, true);
    return {
      ok: true,
      acked: [...acked, ...(Array.isArray(legacy.acked) ? legacy.acked.map(String) : [])],
      missing: [...missing, ...(Array.isArray(legacy.missing) ? legacy.missing.map(String) : [])],
    };
  }

  /** Lazily opened; only ever touched while UBUS_V3=1. */
  private hub(): Hub {
    if (!this.v3hub) {
      this.v3hub = openHub({
        dbPath: process.env.UBUS_V3_DB || join(this.config.dataDir, "v3", "eventlog.db"),
        clock: this.clock,
        allowlistPath: process.env.UBUS_V3_ALLOWLIST,
        exists: (handle: string) => {
          const agent = this.store.getAgent(handle);
          return !!agent && !agent.closed && this.presenceOf(agent) !== "gone";
        },
      });
    }
    return this.v3hub;
  }

  private ensureSystem(): void {
    for (const handle of ["ubus", STEWARD]) {
      if (this.store.getAgent(handle)) continue;
      const ts = this.clock.iso();
      this.store.upsertAgent({
        handle,
        machine: "mini",
        runtime: "other",
        session: `proc:${handle}`,
        owner: "fable",
        orchestrator: "fable",
        capabilitiesJson: JSON.stringify({ accepts: ["msg"], wake: "poll", system: true }),
        address: `agent://mini/other/proc:${handle}`,
        presence: "live",
        discovered: 0,
        closed: 0,
        lastHeartbeatAt: ts,
        lastTurnAt: "",
        registeredAt: ts,
        via: "local",
        machineVerified: 1,
        platformClass: "",
        labelMachineMismatch: 0,
        inboxCursor: 0,
      });
    }
  }

  private requireSender(caller: Caller): AgentRow {
    if (!caller.handle) throw notRegistered();
    const agent = this.store.getAgent(caller.handle);
    if (!agent || agent.closed) throw notRegistered();
    return agent;
  }

  private presenceOf(agent: AgentRow, now = this.clock.now()): string {
    if (agent.closed) return "gone";
    if (isSystem(agent)) return "live";
    const beat = Date.parse(agent.lastHeartbeatAt || agent.registeredAt);
    const age = now - (Number.isFinite(beat) ? beat : now);
    if (agent.runtime === "grok") return age > GONE_MS ? "gone" : "turn-based";
    if (agent.runtime === "cowork") return age > GONE_MS ? "gone" : "poll";
    if (age <= LIVE_MS) return "live";
    if (age <= STALE_GONE_MS) return "stale";
    if (this.herdrLive.has(`${agent.machine}/${agent.handle}`)) return "stale";
    return "gone";
  }

  /** handle -> transport session id that registered it. In memory: a restarted server makes each session register again. */
  private readonly claims = new Map<string, { sessionId: string; secondary: boolean }>();
  /** owner id -> last call, so a crashed shim's claims free up after CLAIM_IDLE_MS. */
  private readonly transportSeen = new Map<string, number>();

  private claimOwner(handle: string): string | undefined {
    return this.claims.get(handle)?.sessionId;
  }

  /**
   * True when another connection holds this handle and has called within CLAIM_IDLE_MS.
   * Only claims with a stable owner count: a shim's x-ubus-instance ("i:...") or any secondary claim.
   * A stateless client gets a new MCP session per call, so its claims prove nothing.
   */
  private heldByOther(handle: string, sessionId: string | undefined, secondaryOnly = false): boolean {
    const held = this.claims.get(handle);
    if (!held || held.sessionId === sessionId) return false;
    if (secondaryOnly ? !held.secondary : !(held.secondary || held.sessionId.startsWith("i:"))) return false;
    return this.clock.now() - (this.transportSeen.get(held.sessionId) ?? 0) < CLAIM_IDLE_MS;
  }

  /** The row a register lands on, resolved exactly as register() does: only an existing session match is a takeover. */
  private registerTarget(args: Record<string, unknown>, caller: Caller): string | undefined {
    const handle = asString(args.handle);
    const machine = (asString(args.machine) || caller.machine || "").toLowerCase();
    const runtime = asString(args.runtime, "other");
    if (!handle || !machine) return undefined;
    return this.store.getAgentBySession(machine, runtime, asString(args.session) || `h:${handle}`)?.handle;
  }

  /**
   * A SECONDARY registration is an extra handle on an already-bound connection (a Cowork session on a shared shim).
   * It is refused when any other live connection holds the row (a pane, or another Cowork claim): a squatter cannot lock a pane out.
   * A connection's own first registration is refused only against a live secondary claim, so a hard-killed pane
   * restarting with the same handle and session gets its handle back at once.
   */
  private checkClaim(args: Record<string, unknown>, caller: Caller): void {
    const target = this.registerTarget(args, caller);
    if (!target || !caller.sessionId) return;
    const secondary = Boolean(caller.handle) && target !== caller.handle;
    if (this.heldByOther(target, caller.sessionId, !secondary)) throw new BusError("handle_in_use", `${target} is registered by another live connection`);
  }

  private claim(result: ToolResult, caller: Caller): ToolResult {
    if (result.ok && typeof result.handle === "string" && caller.sessionId) {
      this.claims.set(result.handle, { sessionId: caller.sessionId, secondary: Boolean(caller.handle) && result.handle !== caller.handle });
    }
    return result;
  }

  private pruneSeen(now: number): void {
    if (this.transportSeen.size < 256) return;
    const owned = new Set([...this.claims.values()].map((c) => c.sessionId));
    for (const [id, t] of this.transportSeen) if (now - t >= CLAIM_IDLE_MS && !owned.has(id)) this.transportSeen.delete(id);
  }

  /** Clean shutdown of a connection frees every handle it claimed. */
  private releaseClaims(sessionId: string | undefined): void {
    if (!sessionId) return;
    for (const [h, c] of this.claims) if (c.sessionId === sessionId) this.claims.delete(h);
    this.transportSeen.delete(sessionId);
  }

  private register(args: Record<string, unknown>, caller: Caller): ToolResult {
    const claimed = (asString(args.machine) || caller.machine || "").toLowerCase();
    if (!validMachine(claimed)) throw new BusError("invalid", "machine is required");
    if (isDeniedMachine(claimed) || isDeniedMachine(caller.machine)) throw new BusError("denied_kiosk");
    const runtime = asString(args.runtime, "other");
    if (!validRuntime(runtime)) throw new BusError("invalid", "unknown runtime");
    let handle = asString(args.handle);
    if (!handle) throw new BusError("invalid", "handle is required");
    if (PANE_ID_RE.test(handle)) throw new BusError("invalid", "handle is a herdr pane id; set HERDR_AGENT_NAME");
    if (!validHandle(handle)) throw new BusError("invalid", "handle is not a label");
    // The session is optional. Default h:<handle> so registering again by name is idempotent.
    const session = asString(args.session) || `h:${handle}`;
    if (session.length > 200) throw new BusError("invalid", "session is too long");
    if (addressDenied(`agent://${claimed}/${runtime}/${session}`)) throw new BusError("denied_kiosk");
    const owner = asString(args.owner, "fable");
    const orchestrator = asString(args.orchestrator, owner || "fable");
    const incoming = args.capabilities && typeof args.capabilities === "object" ? (args.capabilities as Record<string, unknown>) : {};
    const mismatch = caller.machineVerified && claimed !== caller.machine.toLowerCase();
    const ts = this.clock.iso();
    const presence = runtime === "grok" ? "turn-based" : runtime === "cowork" ? "poll" : "live";

    let bySession = this.store.getAgentBySession(claimed, runtime, session);
    if (!bySession) {
      // A row archived for being gone comes back when the same session registers again.
      const revived = this.store.reviveFromArchive(claimed, runtime, session, ts);
      if (revived) {
        bySession = revived;
        this.logPresence(revived, "revive");
      }
    }
    if (bySession) {
      if (PANE_ID_RE.test(bySession.handle) && handle !== bySession.handle) {
        // A pane-id handle gets its real name. Skip when another live row owns that name.
        const taken = this.store.getAgent(handle);
        if (!taken || taken.closed || this.presenceOf(taken) === "gone") {
          if (taken) this.store.archiveAgent(handle, ts);
          this.store.renameAgent(bySession.handle, handle);
          bySession.handle = handle;
        }
      }
      bySession.owner = owner;
      bySession.orchestrator = orchestrator;
      bySession.capabilitiesJson = JSON.stringify({ ...parseJson(bySession.capabilitiesJson), ...incoming });
      bySession.presence = presence;
      bySession.closed = 0;
      bySession.lastHeartbeatAt = ts;
      if (runtime === "grok") bySession.lastTurnAt = ts;
      bySession.via = caller.via;
      bySession.machineVerified = caller.machineVerified ? 1 : 0;
      bySession.platformClass = caller.platformClass ?? "";
      bySession.labelMachineMismatch = mismatch ? 1 : 0;
      this.store.upsertAgent(bySession);
      this.logPresence(bySession, "register");
      return this.registerResult(bySession, false, handle);
    }

    let renamed = false;
    const requested = handle;
    const holder = this.store.getAgent(handle);
    if (holder && this.presenceOf(holder) !== "gone" && !holder.closed) {
      handle = `${requested}@${claimed}`;
      renamed = true;
      if (!validHandle(handle) || (this.store.getAgent(handle) && this.presenceOf(this.store.getAgent(handle)!) !== "gone")) {
        handle = `${requested}@${claimed}-${id("", this.clock.now()).slice(-4)}`;
        renamed = true;
      }
    } else if (holder && (holder.closed || this.presenceOf(holder) === "gone")) {
      // No hard deletes: the old holder moves to the archive.
      this.store.archiveAgent(holder.handle, ts);
    }
    const stale = this.store.getAgent(handle);
    if (stale && stale.handle !== requested) this.store.archiveAgent(stale.handle, ts);

    const row: AgentRow = {
      handle,
      machine: claimed,
      runtime,
      session,
      owner,
      orchestrator,
      capabilitiesJson: JSON.stringify(incoming),
      address: formatAddress(claimed, runtime, session),
      presence,
      discovered: 0,
      closed: 0,
      lastHeartbeatAt: ts,
      lastTurnAt: runtime === "grok" ? ts : "",
      registeredAt: ts,
      via: caller.via,
      machineVerified: caller.machineVerified ? 1 : 0,
      platformClass: caller.platformClass ?? "",
      labelMachineMismatch: mismatch ? 1 : 0,
      inboxCursor: 0,
    };
    this.store.upsertAgent(row);
    this.logPresence(row, "register");
    return this.registerResult(row, renamed, requested);
  }

  private registerResult(row: AgentRow, renamed: boolean, requested: string): ToolResult {
    const unread = this.store.unreadCount(row.handle);
    const clientVersion = clientVersionOf(row);
    return {
      ok: true,
      handle: row.handle,
      address: row.address,
      presence: this.presenceOf(row),
      unread,
      inbox_cursor: row.inboxCursor,
      renamed,
      requested_handle: requested,
      label_machine_mismatch: row.labelMachineMismatch === 1,
      machine_verified: row.machineVerified === 1,
      machine: row.machine,
      session: row.session,
      client_version: clientVersion || null,
      outdated: this.isOutdated(clientVersion),
      min_client_version: this.config.minClientVersion,
    };
  }

  /** A client that reports no version predates 0.2.0 and counts as outdated. */
  private isOutdated(clientVersion: string): boolean {
    if (!clientVersion) return true;
    return compareVersions(clientVersion, this.config.minClientVersion) < 0;
  }

  private heartbeat(caller: Caller): ToolResult {
    const agent = this.requireSender(caller);
    if (isDeniedMachine(agent.machine)) throw new BusError("denied_kiosk");
    agent.lastHeartbeatAt = this.clock.iso();
    if (agent.runtime === "grok") {
      agent.lastTurnAt = agent.lastHeartbeatAt;
      agent.presence = "turn-based";
    } else if (agent.runtime === "cowork") agent.presence = "poll";
    else agent.presence = "live";
    this.store.upsertAgent(agent);
    return { ok: true, handle: agent.handle, presence: this.presenceOf(agent) };
  }

  private unregister(caller: Caller): ToolResult {
    const agent = this.requireSender(caller);
    this.releaseClaims(caller.sessionId);
    agent.closed = 1;
    agent.presence = "gone";
    this.store.upsertAgent(agent);
    this.logPresence(agent, "unregister");
    return { ok: true, handle: agent.handle, presence: "gone" };
  }

  private whoami(caller: Caller): ToolResult {
    if (!caller.handle) {
      return { ok: true, handle: null, machine: caller.machine, via: caller.via, machine_verified: caller.machineVerified };
    }
    const agent = this.store.getAgent(caller.handle);
    if (!agent || agent.closed) {
      return { ok: true, handle: caller.handle, registered: false, machine: caller.machine, via: caller.via };
    }
    return {
      ok: true,
      registered: true,
      handle: agent.handle,
      address: agent.address,
      presence: this.presenceOf(agent),
      machine: agent.machine,
      machine_verified: agent.machineVerified === 1,
      runtime: agent.runtime,
      owner: agent.owner,
      orchestrator: agent.orchestrator,
      unread: this.store.unreadCount(agent.handle),
      via: caller.via,
      platform_class: caller.platformClass ?? agent.platformClass,
    };
  }

  private directory(args: Record<string, unknown>): ToolResult {
    const runtime = asString(args.runtime);
    const machine = asString(args.machine);
    const owner = asString(args.owner);
    const presence = asString(args.presence);
    const group = asString(args.group);
    const q = asString(args.q).toLowerCase();
    const groupMembers = group ? new Set(this.expandGroup(group, { handle: "fable", machine: "mini", machineVerified: true, via: "local" }, true)) : null;
    const rows = this.store.listAgents().map((a) => this.publicAgent(a));
    for (const discovered of this.herdr.listAgents()) {
      if (rows.some((r) => r.handle === discovered.name && r.machine === discovered.machine)) continue;
      rows.push(this.discoveredAgent(discovered));
    }
    const filtered = rows.filter((r) => {
      if (runtime && r.runtime !== runtime) return false;
      if (machine && r.machine !== machine) return false;
      if (owner && r.owner !== owner) return false;
      if (!presence && r.presence === "gone") return false;
      if (presence && presence !== "all" && r.presence !== presence && !(presence === "live" && r.presence === "live (discovered)")) return false;
      if (groupMembers && !groupMembers.has(String(r.handle))) return false;
      if (q) {
        const blob = `${r.handle} ${r.owner} ${r.session} ${r.address}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return r.handle !== "ubus" && r.handle !== STEWARD;
    });
    return { ok: true, agents: filtered };
  }

  private publicAgent(a: AgentRow): Record<string, unknown> {
    const presence = a.discovered ? "live (discovered)" : this.presenceOf(a);
    return {
      handle: a.handle,
      machine: a.machine,
      runtime: a.runtime,
      session: a.session,
      owner: a.owner,
      orchestrator: a.orchestrator,
      address: a.address,
      presence,
      discovered: a.discovered === 1,
      client_version: clientVersionOf(a) || null,
      machine_verified: a.machineVerified === 1,
      label_machine_mismatch: a.labelMachineMismatch === 1,
      last_heartbeat_at: a.lastHeartbeatAt,
      last_turn_at: a.lastTurnAt,
    };
  }

  private discoveredAgent(a: HerdrAgent): Record<string, unknown> {
    const session = `herdr:${a.herdrSession || "default"}/${a.name}`;
    return {
      handle: a.name,
      machine: a.machine,
      runtime: a.runtime,
      session,
      owner: a.owner,
      orchestrator: a.owner || "fable",
      address: formatAddress(a.machine, a.runtime, session),
      presence: "live (discovered)",
      discovered: true,
      machine_verified: false,
      label_machine_mismatch: false,
      herdr_state: a.state,
      busy: a.busy,
    };
  }

  private resolve(args: Record<string, unknown>): ToolResult {
    const name = asString(args.name);
    if (!name) throw new BusError("invalid", "name is required");
    if (addressDenied(name) || isDeniedMachine(name)) throw new BusError("denied_kiosk");
    if (name.startsWith("group:")) {
      const members = this.expandGroup(name, { handle: "fable", machine: "mini", machineVerified: true, via: "local" }, true);
      return { ok: true, matches: members.map((m) => ({ handle: m, group: name })) };
    }
    const parsed = parseAddress(name);
    if (parsed) {
      if (isDeniedMachine(parsed.machine)) throw new BusError("denied_kiosk");
      const found = this.store.listAgents().find((a) => a.machine === parsed.machine && a.runtime === parsed.runtime && a.session === parsed.session);
      if (found) return { ok: true, matches: [this.publicAgent(found)] };
      return { ok: true, matches: [{ address: parsed.raw, machine: parsed.machine, runtime: parsed.runtime, session: parsed.session, presence: "unknown" }] };
    }
    const exact = this.store.getAgent(name);
    const matches = this.store.listAgents().filter((a) => a.handle === name || a.handle.startsWith(name + "@"));
    if (exact && !matches.some((m) => m.handle === exact.handle)) matches.push(exact);
    for (const h of this.herdr.listAgents()) {
      if (h.name === name && !matches.some((m) => m.handle === h.name)) {
        return { ok: true, matches: [...matches.map((m) => this.publicAgent(m)), this.discoveredAgent(h)] };
      }
    }
    return { ok: true, matches: matches.map((m) => this.publicAgent(m)) };
  }

  private groupsTool(): ToolResult {
    const defs = this.readGroups();
    const out: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(defs)) {
      try {
        const members = this.membersOf(name, def, null);
        out[name] = { members, count: members.length, owner_gated_grok: !!def.owner_gated_grok, restricted: !!def.restricted };
      } catch {
        out[name] = { members: [], error: "unavailable" };
      }
    }
    return { ok: true, groups: out };
  }

  private send(args: Record<string, unknown>, caller: Caller, kind: string): ToolResult {
    const sender = this.requireSender(caller);
    return this.deliver(args, sender, kind, true);
  }

  /** The message row and every delivery row commit together or not at all. */
  private deliver(args: Record<string, unknown>, sender: AgentRow, kind: string, countSend: boolean): ToolResult {
    return this.store.transaction(() => this.deliverTx(args, sender, kind, countSend));
  }

  private deliverTx(args: Record<string, unknown>, sender: AgentRow, kind: string, countSend: boolean): ToolResult {
    const targets = this.normalizeTo(args.to);
    if (!targets.length) throw new BusError("invalid", "to is required");
    const subject = asString(args.subject);
    const body = asString(args.body);
    let joined = asString(args.thread_id);
    const replyTo = asString(args.reply_to);
    if (replyTo) {
      const parent = this.store.getMessage(replyTo);
      if (!parent) throw new BusError("invalid", "reply_to not found");
      joined = parent.threadId;
    }
    const phiApplied = this.assertText(sender, subject, body, "ubus_send", targets, asBool(args.mirror_eta, false), joined);
    this.assertArtifacts(args.artifacts);
    if (countSend) this.consumeSend(sender);
    const idem = asString(args.idempotency_key);
    if (idem) {
      const prev = this.store.getIdempotency(sender.handle, idem);
      if (prev && this.clock.now() - Date.parse(prev.createdAt) < IDEMPOTENCY_MS) {
        const msg = this.store.getMessage(prev.messageId);
        return { ok: true, idempotent: true, id: prev.messageId, thread_id: msg?.threadId, delivery: msg ? JSON.parse(msg.deliveryJson || "[]") : [] };
      }
    }
    const expanded: string[] = [];
    for (const t of targets) {
      if (t.startsWith("group:")) expanded.push(...this.expandGroup(t, this.callerFrom(sender), false));
      else expanded.push(t);
    }
    if (expanded.length > 25) throw new BusError("group_too_large");
    const plans = expanded.map((name) => ({ name, plan: this.planSafe(name, sender) }));
    if (plans.every((p) => p.plan.kind === "unknown")) {
      return { ok: false, error: "unknown_agent", to: expanded };
    }
    let threadId = joined;
    if (!threadId) threadId = `t-${id("", this.clock.now())}`;
    const priority = asString(args.priority, "normal");
    if (!["low", "normal", "high"].includes(priority)) throw new BusError("invalid", "bad priority");
    const wake = asBool(args.wake, false);
    const mirror = asBool(args.mirror_eta, false);
    const msgId = `ubus:${id("", this.clock.now())}`;
    const deliveries: Array<Record<string, unknown>> = [];
    const toHandles: string[] = [];
    const ts = this.clock.iso();
    const phi = { class: "none", checked_by: FILTER_ID, scope: phiApplied ? "all" : "internal" };
    const from = this.fromEnvelope(sender);

    for (const { name, plan } of plans) {
      if (plan.kind === "unknown") {
        deliveries.push({ to: name, status: "unknown_agent" });
        continue;
      }
      if (plan.kind === "inbox") {
        const status = this.storeInbox(plan.handle, msgId, ts, "", wake);
        deliveries.push({ to: plan.handle, status });
        toHandles.push(plan.handle);
        if (mirror) {
          const bridged = this.bridgeOut({ sender, to: plan.handle, subject, body, threadId, messageId: msgId, forPane: "" });
          deliveries.push({ to: plan.handle, status: bridged.status, eta_id: bridged.etaId });
        }
      } else if (plan.kind === "lead") {
        if (plan.leadLive) {
          const status = this.storeInbox(plan.lead, msgId, ts, plan.pane, false);
          deliveries.push({ to: plan.lead, status: "lead_routed", for_pane: plan.pane, stored_as: status });
          toHandles.push(plan.lead);
        } else {
          const bridged = this.bridgeOut({ sender, to: plan.lead, subject, body, threadId, messageId: msgId, forPane: plan.pane });
          deliveries.push({ to: plan.lead, status: bridged.status === "bridged_eta" ? "lead_routed" : bridged.status, for_pane: plan.pane, via: "eta", eta_id: bridged.etaId });
        }
      } else if (plan.kind === "eta") {
        const bridged = this.bridgeOut({ sender, to: plan.to, subject, body, threadId, messageId: msgId, forPane: plan.forPane });
        deliveries.push({ to: plan.to, status: bridged.status, for_pane: plan.forPane || undefined, eta_id: bridged.etaId });
      } else if (plan.kind === "openbot") {
        const content = `${subject}\n${body}`;
        try {
          this.openbot.post(plan.handle, content);
        } catch (err) {
          this.noteBridgeFailure(plan.handle, err);
          deliveries.push({ to: plan.handle, status: "openbot_failed" });
          continue;
        }
        this.store.insertDelivery({ messageId: msgId, toHandle: plan.handle, status: "openbot", createdAt: ts, forPane: "" });
        deliveries.push({ to: plan.handle, status: "openbot" });
        this.archive.append({
          src: "openbot",
          event: "msg",
          essential: false,
          rec: { to: plan.handle, bytes: bytesLen(content), sha256: sha256(content), ubus_id: msgId },
        });
      }
    }

    const message: MessageRow = {
      id: msgId,
      ts,
      threadId,
      replyTo,
      fromHandle: sender.handle,
      fromJson: JSON.stringify(from),
      toJson: JSON.stringify(toHandles.length ? toHandles : expanded),
      ccJson: JSON.stringify(Array.isArray(args.cc) ? args.cc : []),
      groupName: targets.find((t) => t.startsWith("group:")) ?? "",
      subject,
      body,
      bodySha256: sha256(body),
      kind,
      corrJson: "",
      priority,
      wake: wake ? 1 : 0,
      artifactsJson: JSON.stringify(args.artifacts ?? []),
      bridgeJson: "",
      phiJson: JSON.stringify(phi),
      deliveryJson: JSON.stringify(deliveries),
      idempotencyKey: idem,
    };
    this.store.insertMessage(message);
    if (idem) this.store.putIdempotency(sender.handle, idem, msgId, ts);
    this.archive.append({
      src: "ubus",
      event: "msg",
      essential: true,
      rec: this.envelopeRec(message),
    });
    for (const handle of toHandles) this.wakeWaiter(handle);
    return { ok: true, id: msgId, thread_id: threadId, schema: SCHEMA_MSG, delivery: deliveries };
  }

  private reply(args: Record<string, unknown>, caller: Caller): ToolResult {
    return this.store.transaction(() => this.replyTx(args, caller));
  }

  private replyTx(args: Record<string, unknown>, caller: Caller): ToolResult {
    const sender = this.requireSender(caller);
    const replyTo = asString(args.reply_to);
    if (!replyTo) throw new BusError("invalid", "reply_to is required");
    const parent = this.store.getMessage(replyTo);
    if (!parent) throw new BusError("invalid", "reply_to not found");
    if (!this.store.participant(parent.threadId, sender.handle) && parent.fromHandle !== sender.handle) {
      throw new BusError("forbidden");
    }
    const body = asString(args.body);
    const subject = asString(args.subject, parent.subject.startsWith("Re:") ? parent.subject : `Re: ${parent.subject}`);
    const cc = JSON.parse(parent.ccJson || "[]") as string[];
    const recipients = [parent.fromHandle, ...cc].filter((h) => h && h !== sender.handle);
    const bridge = parent.bridgeJson ? (JSON.parse(parent.bridgeJson) as Record<string, unknown>) : null;
    const etaReply = bridge?.direction === "eta->ubus" || parent.fromHandle.startsWith("eta:");
    const phiApplied = this.assertText(sender, subject, body, "ubus_reply", recipients, !!etaReply || asBool(args.mirror_eta, false), parent.threadId);
    this.consumeSend(sender);
    const corrId = asString(args.corr_id);
    const msgId = `ubus:${id("", this.clock.now())}`;
    const ts = this.clock.iso();
    const deliveries: Array<Record<string, unknown>> = [];
    const toHandles: string[] = [];
    if (etaReply && bridge) {
      const etaSender = String(bridge.eta_sender || parent.fromHandle.replace(/^eta:/, ""));
      const bridged = this.bridgeOut({
        sender,
        to: etaSender,
        subject,
        body,
        threadId: parent.threadId,
        messageId: msgId,
        forPane: "",
        replyToEta: String(bridge.eta_id || ""),
        etaThread: String(bridge.eta_thread_id || ""),
      });
      deliveries.push({ to: parent.fromHandle, status: bridged.status, eta_id: bridged.etaId });
    } else {
      for (const handle of recipients) {
        const agent = this.store.getAgent(handle);
        const live = agent && !agent.closed && this.presenceOf(agent) !== "gone";
        if (live) {
          const status = this.storeInbox(handle, msgId, ts, "", false);
          deliveries.push({ to: handle, status });
          toHandles.push(handle);
        } else if (LEADS.has(handle) || handle.startsWith("eta:")) {
          const to = handle.startsWith("eta:") ? handle.slice(4) : handle;
          const bridged = this.bridgeOut({ sender, to, subject, body, threadId: parent.threadId, messageId: msgId, forPane: "" });
          deliveries.push({ to, status: bridged.status, eta_id: bridged.etaId });
        } else {
          const status = this.storeInbox(handle, msgId, ts, "", false);
          deliveries.push({ to: handle, status });
          toHandles.push(handle);
        }
      }
    }
    const kind = corrId ? "response" : "msg";
    const message: MessageRow = {
      id: msgId,
      ts,
      threadId: parent.threadId,
      replyTo,
      fromHandle: sender.handle,
      fromJson: JSON.stringify(this.fromEnvelope(sender)),
      toJson: JSON.stringify(recipients),
      ccJson: JSON.stringify(cc),
      groupName: "",
      subject,
      body,
      bodySha256: sha256(body),
      kind,
      corrJson: corrId ? JSON.stringify({ corr_id: corrId }) : "",
      priority: parent.priority || "normal",
      wake: 0,
      artifactsJson: "[]",
      bridgeJson: "",
      phiJson: JSON.stringify({ class: "none", checked_by: FILTER_ID, scope: phiApplied ? "all" : "internal" }),
      deliveryJson: JSON.stringify(deliveries),
      idempotencyKey: "",
    };
    this.store.insertMessage(message);
    // Only after the message row exists: answer the request, and ack the parent (a reply clears the escalation watch).
    if (corrId) this.completeRequest(corrId, sender.handle, msgId);
    this.store.markAck(sender.handle, replyTo, ts, "replied");
    this.archive.append({ src: "ubus", event: "msg", essential: true, rec: this.envelopeRec(message) });
    for (const handle of toHandles) this.wakeWaiter(handle);
    return { ok: true, id: msgId, thread_id: parent.threadId, kind, delivery: deliveries, corr_id: corrId || undefined };
  }

  private inbox(args: Record<string, unknown>, caller: Caller): ToolResult {
    const handle = caller.handle;
    if (!handle) throw notRegistered();
    const limit = clamp(asNumber(args.limit, 10), 1, 100);
    const unreadOnly = asBool(args.unread_only, true);
    const peek = asBool(args.peek, false);
    const threadId = asString(args.thread_id);
    const rows = this.store.inbox(handle, { unreadOnly, threadId: threadId || undefined, limit });
    const external = this.readerExternal(this.store.getAgent(handle), caller);
    if (!peek && unreadOnly) this.store.markRead(handle, rows.map((r) => r.messageId), this.clock.iso());
    else if (!peek && !unreadOnly) this.store.markRead(handle, rows.filter((r) => !r.readAt).map((r) => r.messageId), this.clock.iso());
    return {
      ok: true,
      messages: rows.map((r) => ({
        id: r.message.id,
        ts: r.message.ts,
        thread_id: r.message.threadId,
        reply_to: r.message.replyTo || null,
        from: JSON.parse(r.message.fromJson || "{}"),
        ...this.redacted(r.message, external),
        kind: r.message.kind,
        corr: r.message.corrJson ? JSON.parse(r.message.corrJson) : null,
        delivery_status: r.status,
        for_pane: r.forPane || null,
        read: !peek,
        acked: !!r.ackedAt,
      })),
    };
  }

  private async wait(args: Record<string, unknown>, caller: Caller): Promise<ToolResult> {
    const agent = this.requireSender(caller);
    if (agent.runtime === "grok" || isGrokHandle(agent.handle)) throw new BusError("grok_no_poll", "Grok bots read ubus_inbox at turn start only");
    const timeout = clamp(asNumber(args.timeout_s, 25), 0, 25);
    const summary = () => this.unreadSummary(agent.handle);
    if (summary().count > 0 || timeout === 0) return { ok: true, ...summary() };
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeout * 1000);
      const list = this.waiters.get(agent.handle) ?? [];
      list.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.waiters.set(agent.handle, list);
    });
    return { ok: true, ...summary() };
  }

  private thread(args: Record<string, unknown>, caller: Caller): ToolResult {
    const handle = caller.handle;
    if (!handle) throw notRegistered();
    const threadId = asString(args.thread_id);
    if (!threadId) throw new BusError("invalid", "thread_id is required");
    if (!this.store.participant(threadId, handle)) throw new BusError("forbidden");
    const external = this.readerExternal(this.store.getAgent(handle), caller);
    const messages = this.store.threadMessages(threadId).map((m) => ({
      id: m.id,
      ts: m.ts,
      from: m.fromHandle,
      to: JSON.parse(m.toJson || "[]"),
      ...this.redacted(m, external),
      kind: m.kind,
      reply_to: m.replyTo || null,
      corr: m.corrJson ? JSON.parse(m.corrJson) : null,
    }));
    return { ok: true, thread_id: threadId, messages };
  }

  private ack(args: Record<string, unknown>, caller: Caller, noteChecked = false): ToolResult {
    const handle = caller.handle;
    if (!handle) throw notRegistered();
    const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
    if (!ids.length) throw new BusError("invalid", "ids required");
    const note = asString(args.note);
    if (note && !noteChecked) this.assertText(this.requireSender(caller), "ack", note, "ubus_ack");
    const acked: string[] = [];
    const missing: string[] = [];
    for (const mid of ids) {
      if (this.store.markAck(handle, mid, this.clock.iso(), note)) acked.push(mid);
      else missing.push(mid);
    }
    this.archive.append({ src: "ubus", event: "ack", essential: true, rec: { handle, ids: acked, note: note ? sha256(note) : null } });
    return { ok: true, acked, missing };
  }

  private request(args: Record<string, unknown>, caller: Caller): ToolResult {
    return this.store.transaction(() => this.requestTx(args, caller));
  }

  private requestTx(args: Record<string, unknown>, caller: Caller): ToolResult {
    const sender = this.requireSender(caller);
    const toRaw = args.to;
    const to = typeof toRaw === "string" ? toRaw : Array.isArray(toRaw) ? String(toRaw[0] ?? "") : "";
    if (!to) throw new BusError("invalid", "to is required");
    const grokTarget = isGrokHandle(to) || to.startsWith("grok:");
    const timeoutS = asNumber(args.timeout_s, grokTarget ? 86400 : 3600);
    const onTimeout = asString(args.on_timeout, grokTarget ? "escalate" : "expire");
    if (!["escalate", "expire", "retry_once"].includes(onTimeout)) throw new BusError("invalid", "bad on_timeout");
    const sent = this.deliver({ ...args, to: [to], wake: asBool(args.wake, false) }, sender, "request", true);
    if (!sent.ok) return sent;
    const corrId = `c-${id("", this.clock.now())}`;
    const timeoutAt = new Date(this.clock.now() + timeoutS * 1000).toISOString();
    const delivery = (sent.delivery as Array<Record<string, unknown>>) || [];
    const toHandle = String(delivery.find((d) => d.status === "lead_routed")?.to || delivery.find((d) => INBOX.has(String(d.status)))?.to || to);
    this.store.insertRequest({
      corrId,
      threadId: String(sent.thread_id),
      fromHandle: sender.handle,
      toHandle,
      messageId: String(sent.id),
      timeoutAt,
      onTimeout,
      state: "pending",
      createdAt: this.clock.iso(),
    });
    this.store.updateMessageCorr(String(sent.id), JSON.stringify({ corr_id: corrId, timeout_at: timeoutAt, on_timeout: onTimeout }), "request");
    return { ok: true, corr_id: corrId, thread_id: sent.thread_id, id: sent.id, timeout_at: timeoutAt, on_timeout: onTimeout, delivery: sent.delivery };
  }

  private async awaitReq(args: Record<string, unknown>, caller: Caller): Promise<ToolResult> {
    const sender = this.requireSender(caller);
    const corrId = asString(args.corr_id);
    if (!corrId) throw new BusError("invalid", "corr_id is required");
    const timeout = clamp(asNumber(args.timeout_s, 25), 0, 25);
    const external = this.readerExternal(sender, caller);
    const read = () => this.requestView(corrId, sender.handle, external);
    let view = read();
    if (view.state !== "pending" || timeout === 0) return view;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeout * 1000);
      const list = this.corrWaiters.get(corrId) ?? [];
      list.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.corrWaiters.set(corrId, list);
    });
    view = read();
    return view;
  }

  private requestView(corrId: string, handle: string, external: boolean): ToolResult {
    const req = this.store.getRequest(corrId);
    if (!req) return { ok: false, error: "not_found" };
    if (rowStr(req, "from_handle") !== handle && rowStr(req, "to_handle") !== handle) return { ok: false, error: "forbidden" };
    const state = rowStr(req, "state");
    const responseId = rowStr(req, "response_id");
    const response = responseId ? this.store.getMessage(responseId) : undefined;
    return {
      ok: true,
      corr_id: corrId,
      state,
      response_id: responseId || null,
      body_sha256: response?.bodySha256 ?? null,
      body: state === "answered" && response ? this.redacted(response, external).body : null,
      thread_id: rowStr(req, "thread_id"),
    };
  }

  private requests(args: Record<string, unknown>, caller: Caller): ToolResult {
    const sender = this.requireSender(caller);
    const direction = asString(args.direction, "in") === "out" ? "out" : "in";
    const state = asString(args.state);
    const rows = this.store.listRequests(sender.handle, direction, state || undefined);
    return {
      ok: true,
      requests: rows.map((r) => ({
        corr_id: rowStr(r, "corr_id"),
        thread_id: rowStr(r, "thread_id"),
        from: rowStr(r, "from_handle"),
        to: rowStr(r, "to_handle"),
        state: rowStr(r, "state"),
        timeout_at: rowStr(r, "timeout_at"),
        on_timeout: rowStr(r, "on_timeout"),
        message_id: rowStr(r, "message_id"),
        response_id: rowStr(r, "response_id") || null,
      })),
    };
  }

  private escalate(args: Record<string, unknown>, caller: Caller): ToolResult {
    const sender = this.requireSender(caller);
    const reason = asString(args.reason);
    const about = asString(args.about);
    const severity = asString(args.severity, "info");
    if (!["info", "blocked", "urgent"].includes(severity)) throw new BusError("invalid", "bad severity");
    const hop = this.nextHop(sender);
    this.assertText(sender, `escalate ${about}`, reason, "ubus_escalate", [hop], hop === "v");
    if (hop === "v") {
      const body = `Escalation from ${sender.handle} (${severity}). About ${about}. ${reason}`;
      const res = this.handoff.post({ project: "ubus-escalation", title: `ubus escalation ${severity}`, body, fromAgent: sender.handle, tags: ["ubus", severity] });
      this.archive.append({ src: "handoff", event: "escalation", essential: true, rec: { id: res.id, from: sender.handle, project: "ubus-escalation", body_sha256: sha256(body) } });
      return { ok: true, via: "mini-ops", handoff_id: res.id, target: "v" };
    }
    const sent = this.deliver(
      { to: [hop], subject: `escalation ${severity}: ${about}`.slice(0, this.config.limits.subjectMaxChars), body: reason, priority: severity === "urgent" ? "high" : "normal" },
      sender,
      "escalation",
      true,
    );
    return { ...sent, target: hop };
  }

  private broadcast(args: Record<string, unknown>, caller: Caller): ToolResult {
    const sender = this.requireSender(caller);
    const group = asString(args.group);
    if (!group.startsWith("group:")) throw new BusError("invalid", "group is required");
    if (group === "group:all" || group === "all") throw new BusError("forbidden", "no all-group");
    this.consumeRate("broadcast", sender.handle, this.config.limits.broadcastsPerHour);
    this.consumeRate("broadcast", `machine:${sender.machine}`, this.config.limits.broadcastsPerHour);
    const members = this.expandGroup(group, this.callerFrom(sender), false);
    if (members.length > 25) throw new BusError("group_too_large");
    return this.deliver({ ...args, to: members, subject: args.subject, body: args.body }, sender, "broadcast", true);
  }

  private doHandoff(args: Record<string, unknown>, caller: Caller): ToolResult {
    const sender = this.requireSender(caller);
    const project = asString(args.project);
    const title = asString(args.title);
    const body = asString(args.body);
    const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
    if (!project || !title || !body) throw new BusError("invalid", "project, title, body required");
    this.assertText(sender, title, body, "ubus_handoff", [], true);
    const res = this.handoff.post({ project, title, body, fromAgent: sender.handle, tags });
    this.archive.append({
      src: "handoff",
      event: "msg",
      essential: true,
      rec: { id: res.id, project, from: sender.handle, title, body_sha256: sha256(body), tags },
    });
    return { ok: true, id: res.id };
  }

  private grant(args: Record<string, unknown>, caller: Caller): ToolResult {
    const sender = this.requireSender(caller);
    const grantee = asString(args.grantee);
    const target = asString(args.target) || asString(args.address);
    const verbs = Array.isArray(args.verbs) ? args.verbs.map(String) : [];
    const expiresIn = asNumber(args.expires_in, 3600);
    if (!grantee || !target || !verbs.length) throw new BusError("invalid", "grantee, target, verbs required");
    if (verbs.some((v) => !(GRANT_VERBS as readonly string[]).includes(v))) throw new BusError("invalid", "verb not grantable");
    if (expiresIn <= 0 || expiresIn > this.config.limits.grantMaxMs / 1000) throw new BusError("invalid", "expires_in must be ≤ 8h");
    const agent = this.agentByTarget(target);
    if (!agent) throw new BusError("unknown_agent");
    if (agent.owner !== sender.handle) throw new BusError("forbidden", "only the owner can grant");
    const gid = `g-${id("", this.clock.now())}`;
    const exp = new Date(this.clock.now() + expiresIn * 1000).toISOString();
    this.store.insertGrant({ id: gid, grantor: sender.handle, grantee, target: agent.handle, verbsJson: JSON.stringify(verbs), expiresAt: exp, createdAt: this.clock.iso() });
    this.archive.append({ src: "ubus", event: "grant", essential: true, rec: { id: gid, grantor: sender.handle, grantee, target: agent.handle, verbs, expires_at: exp } });
    return { ok: true, grant_id: gid, expires_at: exp, target: agent.handle };
  }

  private approvalRequest(args: Record<string, unknown>, caller: Caller): ToolResult {
    const sender = this.requireSender(caller);
    const action = asString(args.action);
    if (!(DESTRUCTIVE_TOOLS as readonly string[]).includes(action)) throw new BusError("invalid", "action is not a destructive verb");
    const raw = asObject(args.args);
    this.rejectKioskIn(raw);
    this.rejectSecretPathsIn(raw);
    const scope = asString(raw.scope);
    if (scope === "kiosk") throw new BusError("denied_kiosk");
    const engineeringOnly = scope === "patient" || scope === "prod" || scope === "spend" || raw.engineering_only === false ? 0 : 1;
    const argsCanonical = canonical(raw);
    const argsSha = sha256(argsCanonical);
    const aid = `ap-${id("", this.clock.now())}`;
    const exp = new Date(this.clock.now() + this.config.limits.approvalTtlMs).toISOString();
    this.store.insertApproval({
      id: aid,
      requester: sender.handle,
      action,
      argsSha256: argsSha,
      argsCanonical,
      engineeringOnly,
      expiresAt: exp,
      createdAt: this.clock.iso(),
    });
    this.archive.append({
      src: "ubus",
      event: "approval",
      essential: true,
      rec: { id: aid, requester: sender.handle, action, args_sha256: argsSha, engineering_only: engineeringOnly === 1, state: "pending" },
    });
    return { ok: true, approval_id: aid, args_sha256: argsSha, state: "pending", expires_at: exp, engineering_only: engineeringOnly === 1 };
  }

  private approve(args: Record<string, unknown>, caller: Caller): ToolResult {
    const sender = this.requireSender(caller);
    const aid = asString(args.approval_id);
    const row = this.store.getApproval(aid);
    if (!row) throw new BusError("not_found");
    if (rowStr(row, "state") !== "pending") throw new BusError("approval_used", `state is ${rowStr(row, "state")}`);
    if (Date.parse(rowStr(row, "expires_at")) <= this.clock.now()) throw new BusError("approval_expired");
    const engineering = rowNum(row, "engineering_only") === 1;
    const allowed = engineering ? this.config.approvers.engineering : this.config.approvers.elevated;
    if (!allowed.includes(sender.handle)) throw new BusError(engineering ? "forbidden" : "elevated_approver_required");
    const exp = new Date(this.clock.now() + this.config.limits.approvalTtlMs).toISOString();
    this.store.updateApproval(aid, { state: "approved", approver: sender.handle, expiresAt: exp });
    this.archive.append({ src: "ubus", event: "approval", essential: true, rec: { id: aid, approver: sender.handle, state: "approved", args_sha256: rowStr(row, "args_sha256") } });
    return { ok: true, approval_id: aid, state: "approved", expires_at: exp };
  }

  private destructive(tool: string, args: Record<string, unknown>, caller: Caller): ToolResult {
    const sender = this.requireSender(caller);
    this.consumeRate("control", sender.handle, this.config.limits.controlPerHour);
    const { approval_id: approvalIdRaw, ...rest } = args;
    this.rejectKioskIn(rest);
    this.rejectSecretPathsIn(rest);
    const canonicalArgs = canonical(rest);
    const hash = sha256(canonicalArgs);
    const approvalId = typeof approvalIdRaw === "string" ? approvalIdRaw : "";
    const row = approvalId ? this.store.getApproval(approvalId) : this.store.findApproved(tool, hash, this.clock.iso());
    if (!row) throw new BusError("approval_required");
    const state = rowStr(row, "state");
    if (state === "used") throw new BusError("approval_used");
    if (state === "pending") throw new BusError("not_approved");
    if (state !== "approved") throw new BusError("approval_required");
    if (Date.parse(rowStr(row, "expires_at")) <= this.clock.now()) throw new BusError("approval_expired");
    if (rowStr(row, "action") !== tool || rowStr(row, "args_sha256") !== hash) throw new BusError("approval_mismatch");
    const idOf = rowStr(row, "id");
    this.store.updateApproval(idOf, { state: "used", usedAt: this.clock.iso() });
    this.archive.append({
      src: "agent-io",
      event: "call",
      essential: false,
      rec: { verb: tool, address: asString(rest.address), args_sha256: hash, approval_id: idOf, bytes: 0, adapter: "stub" },
    });
    return { ok: true, stub: true, adapter: "stub", verb: tool, approval_id: idOf, executed: false };
  }

  private agentSend(args: Record<string, unknown>, caller: Caller): ToolResult {
    const sender = this.requireSender(caller);
    this.consumeRate("control", sender.handle, this.config.limits.controlPerHour);
    const address = asString(args.address) || asString(args.to);
    const text = asString(args.text);
    if (!address || !text) throw new BusError("invalid", "address and text required");
    this.rejectKioskIn({ address });
    this.assertText(sender, "agent send", text, "ubus_agent_send", [address]);
    const target = this.describeTarget(address);
    if (target.pane && isGrokHandle(sender.handle)) {
      const lead = target.owner || "fable";
      const routed = this.deliver(
        { to: [target.handle], subject: `input for ${target.handle}`.slice(0, 120), body: text },
        sender,
        "msg",
        false,
      );
      this.archive.append({
        src: "agent-io",
        event: "call",
        essential: false,
        rec: { verb: "ubus_agent_send", address, bytes: bytesLen(text), sha256: sha256(text), delivery: "lead_routed", lead },
      });
      return { ok: true, delivery: "lead_routed", lead, id: routed.id, pane_nudged: false };
    }
    const owns = target.owner === sender.handle || target.handle === sender.handle;
    if (!owns && !this.hasGrant(sender.handle, target.handle, target.address, "send")) throw new BusError("grant_required");
    this.archive.append({
      src: "agent-io",
      event: "call",
      essential: false,
      rec: { verb: "ubus_agent_send", address: target.address || address, bytes: bytesLen(text), sha256: sha256(text), adapter: "stub" },
    });
    return { ok: true, stub: true, adapter: "herdr-send-not-in-mvp", address: target.address || address };
  }

  private ask(args: Record<string, unknown>, caller: Caller): ToolResult {
    const sender = this.requireSender(caller);
    const address = asString(args.address) || asString(args.to);
    const question = asString(args.question);
    if (!address || !question) throw new BusError("invalid", "address and question required");
    const target = this.describeTarget(address);
    if (target.pane && isGrokHandle(sender.handle)) {
      const routed = this.deliver({ to: [target.handle], subject: `ask ${target.handle}`.slice(0, 120), body: question }, sender, "msg", true);
      return { ok: true, delivery: "lead_routed", lead: target.owner, id: routed.id };
    }
    return this.request({ to: address, subject: asString(args.subject, "ask"), body: question, timeout_s: args.timeout_s }, caller);
  }

  private grantVerb(args: Record<string, unknown>, caller: Caller, verb: string, tool: string): ToolResult {
    const sender = this.requireSender(caller);
    this.consumeRate("control", sender.handle, this.config.limits.controlPerHour);
    const address = asString(args.address);
    if (!address) throw new BusError("invalid", "address required");
    this.rejectKioskIn(args);
    const target = this.describeTarget(address);
    if (target.pane && isGrokHandle(sender.handle)) throw new BusError("lead_routed", "Grok input to a herdr pane goes to the owning lead");
    const owns = target.owner === sender.handle || target.handle === sender.handle;
    if (!owns && !this.hasGrant(sender.handle, target.handle, target.address, verb)) throw new BusError("grant_required");
    this.archive.append({ src: "agent-io", event: "call", essential: false, rec: { verb: tool, address, adapter: "stub" } });
    return { ok: true, stub: true, adapter: "stub", verb: tool };
  }

  private agentSessions(args: Record<string, unknown>): ToolResult {
    const machine = asString(args.machine);
    const runtime = asString(args.runtime);
    const dir = this.directory({ machine, runtime });
    return { ok: true, sessions: dir.agents };
  }

  private agentStatus(args: Record<string, unknown>): ToolResult {
    const address = asString(args.address) || asString(args.name);
    if (!address) throw new BusError("invalid", "address required");
    if (addressDenied(address)) throw new BusError("denied_kiosk");
    const target = this.describeTarget(address);
    const herdr = this.herdr.listAgents().find((a) => a.name === target.handle);
    return {
      ok: true,
      handle: target.handle,
      address: target.address,
      owner: target.owner,
      presence: target.presence,
      busy: herdr?.busy ?? false,
      state: herdr?.state ?? target.presence,
      pane: target.pane,
    };
  }

  private agentRead(args: Record<string, unknown>, caller: Caller): ToolResult {
    this.requireSender(caller);
    const address = asString(args.address);
    if (!address) throw new BusError("invalid", "address required");
    this.rejectKioskIn(args);
    this.rejectSecretPathsIn(args);
    this.archive.append({
      src: "agent-io",
      event: "read",
      essential: false,
      rec: { address, bytes: 0, sha256: null, adapter: "stub" },
    });
    return { ok: true, stub: true, text_omitted: true, bytes: 0, sha256: null, path: null, note: "herdr read adapter is not in the MVP" };
  }

  /** A recipient that cannot be planned is "unknown_agent" for that recipient. Policy errors (kiosk) still stop the send. */
  private planSafe(name: string, sender: AgentRow): Plan {
    try {
      return this.planOne(name, sender);
    } catch (err) {
      if (err instanceof BusError) throw err;
      this.noteBridgeFailure(name, err);
      return { kind: "unknown" };
    }
  }

  private planOne(name: string, sender: AgentRow): Plan {
    if (addressDenied(name) || isDeniedMachine(name)) throw new BusError("denied_kiosk");
    const parsed = parseAddress(name);
    if (parsed && isDeniedMachine(parsed.machine)) throw new BusError("denied_kiosk");
    let agent = parsed
      ? this.store.listAgents().find((a) => !a.closed && a.machine === parsed.machine && a.runtime === parsed.runtime && a.session === parsed.session)
      : this.store.getAgent(name);
    if (agent?.closed) agent = undefined;
    const handle = agent?.handle || (parsed ? "" : name);
    const herdr = this.herdr.listAgents().find((a) => a.name === handle || a.name === name);
    const pane = !!(agent?.session.startsWith("herdr:") || herdr);
    if (pane && isGrokHandle(sender.handle)) {
      const lead = agent?.owner || herdr?.owner || "fable";
      const leadAgent = this.store.getAgent(lead);
      const leadLive = !!(leadAgent && !leadAgent.closed && this.presenceOf(leadAgent) !== "gone");
      return { kind: "lead", lead, pane: agent?.handle || herdr?.name || name, leadLive };
    }
    if (agent && this.presenceOf(agent) !== "gone") return { kind: "inbox", handle: agent.handle };
    if (name.startsWith("openbot:")) return { kind: "openbot", handle: name };
    if (herdr && !isGrokHandle(sender.handle)) return { kind: "eta", to: herdr.name, forPane: "" };
    if (!parsed && LEADS.has(name)) return { kind: "eta", to: name, forPane: "" };
    return { kind: "unknown" };
  }

  private storeInbox(handle: string, messageId: string, ts: string, forPane: string, wake: boolean): string {
    const agent = this.store.getAgent(handle);
    let status = agent?.runtime === "cowork" ? "stored_poll" : "stored";
    if (forPane) status = "lead_routed";
    const herdr = this.herdr.listAgents().find((a) => a.name === handle);
    const pane = agent?.session.startsWith("herdr:") || !!herdr;
    if (pane && !forPane && herdr && (herdr.state === "idle" || herdr.state === "done") && !herdr.busy) {
      const last = this.store.lastNudge(handle);
      if (!last || this.clock.now() - Date.parse(last) >= NUDGE_GAP_MS) {
        this.herdr.nudge(handle, herdr.machine);
        this.store.setNudge(handle, ts);
        status = "nudged";
      }
    }
    if (wake && status !== "nudged") {
      const last = this.store.lastWake(handle);
      if (!last || this.clock.now() - Date.parse(last) >= WAKE_GAP_MS) {
        this.store.setWake(handle, ts);
        if (status === "stored") status = "hook_pending";
      }
    }
    const deliveryId = this.store.insertDelivery({ messageId, toHandle: handle, status, createdAt: ts, forPane });
    if (agent) {
      agent.inboxCursor = deliveryId;
      this.store.upsertAgent(agent);
    }
    return status;
  }

  /** A bridge failure is one recipient's delivery status, never a failed send. */
  private bridgeOut(opts: Parameters<Ubus["bridgeOutRaw"]>[0]): { status: string; etaId?: string } {
    try {
      return this.bridgeOutRaw(opts);
    } catch (err) {
      this.noteBridgeFailure(opts.to, err);
      return { status: "bridge_failed" };
    }
  }

  private noteBridgeFailure(to: string, err: unknown): void {
    try {
      this.archive.append({ src: "ubus", event: "bridge_failed", essential: false, rec: { to, error: err instanceof Error ? err.message.slice(0, 120) : "error" } });
    } catch {
      /* logging must not fail the send */
    }
  }

  private bridgeOutRaw(opts: {
    sender: AgentRow;
    to: string;
    subject: string;
    body: string;
    threadId: string;
    messageId: string;
    forPane: string;
    replyToEta?: string;
    etaThread?: string;
  }): { status: string; etaId?: string } {
    const identity = isGrokHandle(opts.sender.handle) ? LIAISON_IDENTITY : BRIDGE_IDENTITY;
    let etaTo = opts.to;
    if (identity === LIAISON_IDENTITY && !LEADS.has(etaTo)) {
      return { status: "unknown_agent" };
    }
    if (identity === LIAISON_IDENTITY && !this.consumeBridgeBudget()) {
      this.store.enqueueBridge({
        identity,
        toHandle: etaTo,
        ubusMessageId: opts.messageId,
        createdAt: this.clock.iso(),
        forPane: opts.forPane,
      });
      return { status: "queued_digest" };
    }
    let subject = `[ubus:${originTag(opts.sender.handle)}] ${opts.subject}`;
    if (opts.forPane) subject = `${forPaneTag(opts.forPane)} ${subject}`;
    const footer = `\n\nubus-id: ${opts.messageId} thread: ${opts.threadId} reply via ubus or reply in this ETA thread`;
    let body = opts.body + footer;
    if (bytesLen(body) > ETA_BODY_MAX_BYTES) body = opts.body;
    const post = this.eta.post({
      as: identity,
      to: etaTo,
      subject,
      body,
      threadId: opts.etaThread,
      replyTo: opts.replyToEta,
      wake: false,
    });
    this.store.insertBridge({
      direction: "ubus->eta",
      ubusMessageId: opts.messageId,
      ubusThreadId: opts.threadId,
      etaId: post.id,
      etaThreadId: post.threadId,
      identity,
      ubusHandle: opts.sender.handle,
      etaParty: etaTo,
      createdAt: this.clock.iso(),
    });
    this.archive.append({
      src: "eta",
      event: "msg",
      essential: true,
      rec: {
        direction: "ubus->eta",
        eta_id: post.id,
        eta_thread_id: post.threadId,
        as: identity,
        to: etaTo,
        subject: post.subject,
        body_sha256: sha256(body),
        ubus_id: opts.messageId,
        for_pane: opts.forPane || null,
      },
    });
    return { status: "bridged_eta", etaId: post.id };
  }

  private consumeBridgeBudget(): boolean {
    const start = new Date(this.clock.now() - HOUR_MS).toISOString();
    const n = this.store.countRate("bridge", LIAISON_IDENTITY, start);
    if (n >= this.config.limits.bridgePerHour) return false;
    this.store.addRate("bridge", LIAISON_IDENTITY, this.clock.iso());
    return true;
  }

  private flushDigests(): void {
    const pending = this.store.pendingBridge(LIAISON_IDENTITY);
    if (!pending.length) return;
    const byTo = new Map<string, typeof pending>();
    for (const row of pending) {
      const list = byTo.get(row.toHandle) ?? [];
      list.push(row);
      byTo.set(row.toHandle, list);
    }
    for (const [to, items] of byTo) {
      if (!this.consumeBridgeBudget()) return;
      const ids = items.map((i) => i.ubusMessageId);
      const subject = `[ubus] ${items.length} messages for you`;
      const body = `${items.length} messages for you, ids ${ids.join(", ")}`;
      const post = this.eta.post({ as: LIAISON_IDENTITY, to, subject, body, wake: false });
      this.store.markBridgePosted(items.map((i) => i.id));
      this.archive.append({
        src: "eta",
        event: "msg",
        essential: true,
        rec: { direction: "ubus->eta", digest: true, eta_id: post.id, to, count: items.length, ids, as: LIAISON_IDENTITY },
      });
    }
  }

  private ingestEta(row: EtaPost): boolean {
    if (row.sender === LIAISON_IDENTITY || row.sender === BRIDGE_IDENTITY || row.identity === LIAISON_IDENTITY || row.identity === BRIDGE_IDENTITY) {
      return false;
    }
    const verdict = filterFields([row.subject, row.body]);
    if (!verdict.ok) {
      this.archive.append({
        src: "eta",
        event: "rejected",
        essential: true,
        rec: {
          reason: verdict.reason === "secret" || verdict.reason === "secret_path" ? "secret" : "phi_suspect",
          rule: verdict.rule,
          body_sha256: verdict.sha256,
          eta_id: row.id,
        },
      });
      return false;
    }
    this.archive.append({
      src: "eta",
      event: "msg",
      essential: true,
      rec: {
        direction: "eta->ubus-seen",
        eta_id: row.id,
        sender: row.sender,
        recipient: row.recipient,
        subject: row.subject,
        body_sha256: verdict.sha256,
      },
    });
    const ours = row.recipient === LIAISON_IDENTITY || row.recipient === BRIDGE_IDENTITY;
    const link = this.store.findBridgeByEta(row.replyTo, row.threadId);
    const tag = extractToTag(row.subject, (row.body.split("\n")[0] ?? "").trim());
    if (link && (row.replyTo || (row.threadId && row.threadId === rowStr(link, "eta_thread_id")))) {
      this.deliverFromEta(row, rowStr(link, "ubus_handle"), rowStr(link, "ubus_thread_id"), rowStr(link, "identity") || row.recipient);
      return true;
    }
    if (ours && tag) {
      const threadId = `t-${id("", this.clock.now())}`;
      this.deliverFromEta(row, tag, threadId, row.recipient);
      return true;
    }
    return false;
  }

  private deliverFromEta(row: EtaPost, toHandle: string, threadId: string, door: string): void {
    this.store.transaction(() => this.deliverFromEtaTx(row, toHandle, threadId, door));
  }

  private deliverFromEtaTx(row: EtaPost, toHandle: string, threadId: string, door: string): void {
    const msgId = `ubus:${id("", this.clock.now())}`;
    const ts = this.clock.iso();
    const fromHandle = `eta:${row.sender}`;
    const bridge = {
      eta_id: row.id,
      eta_thread_id: row.threadId,
      direction: "eta->ubus",
      as: door,
      eta_sender: row.sender,
    };
    const from = {
      handle: fromHandle,
      label: `[eta:${row.sender}]`,
      machine: "mini",
      machine_verified: false,
      runtime: "other",
      via: "local",
    };
    const status = this.storeInbox(toHandle, msgId, ts, "", false);
    const message: MessageRow = {
      id: msgId,
      ts,
      threadId,
      replyTo: "",
      fromHandle,
      fromJson: JSON.stringify(from),
      toJson: JSON.stringify([toHandle]),
      ccJson: "[]",
      groupName: "",
      subject: row.subject,
      body: row.body,
      bodySha256: sha256(row.body),
      kind: "msg",
      corrJson: "",
      priority: "normal",
      wake: 0,
      artifactsJson: "[]",
      bridgeJson: JSON.stringify(bridge),
      phiJson: JSON.stringify({ class: "none", checked_by: FILTER_ID }),
      deliveryJson: JSON.stringify([{ to: toHandle, status }]),
      idempotencyKey: "",
    };
    this.store.insertMessage(message);
    this.store.insertBridge({
      direction: "eta->ubus",
      ubusMessageId: msgId,
      ubusThreadId: threadId,
      etaId: row.id,
      etaThreadId: row.threadId,
      identity: door,
      ubusHandle: toHandle,
      etaParty: row.sender,
      createdAt: ts,
    });
    this.archive.append({ src: "ubus", event: "msg", essential: true, rec: { ...this.envelopeRec(message), bridge } });
    this.wakeWaiter(toHandle);
  }

  private completeRequest(corrId: string, callerHandle: string, responseId: string): void {
    const req = this.store.getRequest(corrId);
    if (!req) throw new BusError("invalid", "unknown corr_id");
    if (rowStr(req, "to_handle") !== callerHandle && rowStr(req, "from_handle") !== callerHandle) throw new BusError("forbidden");
    if (rowStr(req, "to_handle") === callerHandle && rowStr(req, "state") === "pending") {
      this.store.updateRequest(corrId, { state: "answered", responseId });
      this.wakeCorr(corrId);
    }
  }

  private expireRequests(): void {
    for (const req of this.store.dueRequests(this.clock.iso())) {
      const corrId = rowStr(req, "corr_id");
      const mode = rowStr(req, "on_timeout");
      const retried = rowNum(req, "retried");
      if (mode === "retry_once" && retried < 1) {
        const created = Date.parse(rowStr(req, "created_at"));
        const timeoutAt = Date.parse(rowStr(req, "timeout_at"));
        const span = Math.max(1000, timeoutAt - created);
        this.store.updateRequest(corrId, { retried: 1, timeoutAt: new Date(this.clock.now() + span).toISOString() });
        continue;
      }
      if (mode === "escalate") {
        this.store.updateRequest(corrId, { state: "escalated" });
        const from = this.store.getAgent(rowStr(req, "from_handle"));
        if (from && !from.closed) {
          try {
            this.escalate({ about: corrId, reason: `request ${corrId} timed out`, severity: "blocked" }, this.callerFrom(from));
          } catch {
            /* escalation best-effort */
          }
        }
        this.wakeCorr(corrId);
        continue;
      }
      this.store.updateRequest(corrId, { state: "expired" });
      const from = this.store.getAgent(rowStr(req, "from_handle"));
      if (from && !from.closed) {
        this.systemSend(from.handle, `request ${corrId} expired`, `request ${corrId} expired`);
      }
      this.wakeCorr(corrId);
    }
  }

  private nextHop(agent: AgentRow): string {
    if (agent.orchestrator && agent.orchestrator !== agent.handle) return agent.orchestrator;
    if (agent.owner && agent.owner !== agent.handle) return agent.owner;
    if (agent.handle !== "fable") return "fable";
    return "v";
  }

  /** Returns { id } once the message row exists, else { reason }. */
  private systemSend(to: string, subject: string, body: string, from = "ubus", scope: "internal" | "all" = "all"): { id?: string; reason?: string } {
    if (this.alerting) return { reason: "alerting" };
    const sender = this.store.getAgent(from);
    if (!sender) return { reason: "no_sender_row" };
    this.alerting = true;
    try {
      const msgId = `ubus:${id("", this.clock.now())}`;
      const ts = this.clock.iso();
      const threadId = `t-${id("", this.clock.now())}`;
      const message: MessageRow = {
        id: msgId,
        ts,
        threadId,
        replyTo: "",
        fromHandle: from,
        fromJson: JSON.stringify(this.fromEnvelope(sender)),
        toJson: JSON.stringify([to]),
        ccJson: "[]",
        groupName: "",
        subject,
        body,
        bodySha256: sha256(body),
        kind: "event",
        corrJson: "",
        priority: "high",
        wake: 0,
        artifactsJson: "[]",
        bridgeJson: "",
        phiJson: JSON.stringify({ class: "none", checked_by: FILTER_ID, scope }),
        deliveryJson: JSON.stringify([{ to, status: "stored" }]),
        idempotencyKey: "",
      };
      // Message row first, so a failure cannot leave a delivery with no message.
      this.store.insertMessage(message);
      this.store.insertDelivery({ messageId: msgId, toHandle: to, status: "stored", createdAt: ts, forPane: "" });
      this.archive.append({ src: "ubus", event: "event", essential: true, rec: this.envelopeRec(message) });
      this.wakeWaiter(to);
      return { id: msgId };
    } catch (err) {
      return { reason: `error:${err instanceof Error ? err.message.slice(0, 40) : "unknown"}` };
    } finally {
      this.alerting = false;
    }
  }

  raiseAlert(info: ArchiveAlert): void {
    const since = info.since;
    const when = Number.isFinite(Date.parse(since)) ? Date.parse(since) : this.clock.now();
    const body = `TM cold unavailable since ${istStamp(when)} (${info.reason}). spool ${info.spoolBytes} bytes, ${info.pendingSegments} segments pending.`;
    this.systemSend("grok:minibot", "ubus archive degraded", body);
    try {
      const res = this.handoff.post({ project: "ubus-archive", title: "ubus archive degraded", body, fromAgent: "ubus", tags: ["archive"] });
      this.archive.append({ src: "handoff", event: "msg", essential: true, rec: { id: res.id, project: "ubus-archive", body_sha256: sha256(body) } });
    } catch {
      /* handoff is best-effort */
    }
  }

  /** An identity that sits outside the tailnet trust boundary: grok bots and cloudflare-routed agents. */
  private isExternalAgent(agent: AgentRow): boolean {
    return agent.via === "cloudflare" || agent.runtime === "grok" || isGrokHandle(agent.handle);
  }

  /** The reader is outside the trust boundary now: the registered row (grok, cloudflare, takeover) or this very call came through cloudflare. */
  private readerExternal(agent: AgentRow | undefined, caller: Caller): boolean {
    return !agent || caller.via === "cloudflare" || this.isExternalAgent(agent);
  }

  /** Read-time redaction: a message sent under the internal-only scope never reaches an external reader. */
  private redacted(m: MessageRow, external: boolean): { subject: string; body: string } {
    let internal = false;
    if (external) {
      try {
        internal = (JSON.parse(m.phiJson || "{}") as Record<string, unknown>).scope === "internal";
      } catch {
        internal = false;
      }
    }
    return internal ? { subject: REDACTED, body: REDACTED } : { subject: m.subject, body: m.body };
  }

  /**
   * True when the message can leave the tailnet, so PHI and transcript rules must run.
   * recipients undefined means unknown: apply them. Groups are expanded to members.
   * Each recipient is resolved through the real delivery plan (planOne): a plan of kind "eta"
   * means the message is bridged to ETA, which can reach external parties, so the rules apply.
   * threadId: when the message joins an existing thread, every prior participant (senders and recipients) counts as a recipient,
   * because ubus_thread shows the whole thread to all of them.
   */
  private phiApplies(sender: AgentRow, recipients: string[] | undefined, forceExternal: boolean, threadId = ""): boolean {
    if (this.config.filter.phiScope !== "external_only") return true;
    if (forceExternal || !recipients) return true;
    if (this.isExternalAgent(sender)) return true;
    const names: string[] = [];
    for (const r of recipients) {
      if (r.startsWith("group:")) {
        try {
          names.push(...this.expandGroup(r, this.callerFrom(sender), true));
        } catch {
          return true;
        }
      } else names.push(r);
    }
    if (threadId) names.push(...this.threadParticipants(threadId));
    for (const name of names) {
      if (isGrokHandle(name) || name.startsWith("grok:") || name.startsWith("eta:")) return true;
      let plan: Plan;
      try {
        plan = this.planOne(name, sender);
      } catch {
        return true;
      }
      if (plan.kind === "eta" || plan.kind === "lead") return true;
      if (plan.kind === "openbot") continue;
      const parsed = parseAddress(name);
      const agent = parsed
        ? this.store.listAgents().find((a) => !a.closed && a.machine === parsed.machine && a.runtime === parsed.runtime && a.session === parsed.session)
        : this.store.getAgent(name);
      if (!agent || agent.closed) {
        if (name.startsWith("openbot:")) continue;
        return true;
      }
      if (this.isExternalAgent(agent)) return true;
      // plan.kind "unknown" for a live registered non-lead agent (gone): stored in its inbox, never bridged. Internal.
    }
    return false;
  }

  /** Every handle that sent or received a message on the thread, including ETA-bridged recipients. */
  private threadParticipants(threadId: string): string[] {
    const out = new Set<string>();
    for (const m of this.store.threadMessages(threadId)) {
      if (m.fromHandle) out.add(m.fromHandle);
      for (const col of [m.toJson, m.ccJson]) {
        try {
          for (const h of JSON.parse(col || "[]") as unknown[]) if (typeof h === "string" && h) out.add(h);
        } catch {
          /* malformed column: ignore */
        }
      }
      try {
        for (const d of JSON.parse(m.deliveryJson || "[]") as Array<Record<string, unknown>>) {
          if (typeof d.to === "string" && d.to) out.add(d.to);
        }
      } catch {
        /* ignore */
      }
    }
    return [...out];
  }

  private assertText(sender: AgentRow, subject: string, body: string, tool: string, recipients?: string[], forceExternal = false, threadId = "", skipPhi = false): boolean {
    if (!subject || subject.length > this.config.limits.subjectMaxChars) throw new BusError("invalid", "subject length");
    if (!body) throw new BusError("invalid", "body required");
    if (bytesLen(body) > this.config.limits.bodyMaxBytes) throw new BusError("too_large");
    const applied = this.phiApplies(sender, recipients, forceExternal, threadId);
    const verdict = applied && !skipPhi ? filterFields([subject, body]) : filterFieldsSecretsOnly([subject, body]);
    if (!verdict.ok) {
      const reason = verdict.reason === "secret" || verdict.reason === "secret_path" ? "secret" : "phi_suspect";
      this.archive.append({
        src: "ubus",
        event: "rejected",
        essential: true,
        rec: { reason, rule: verdict.rule, body_sha256: verdict.sha256, from: sender.handle, tool },
      });
      throw new BusError(reason === "secret" ? "secret_rejected" : "phi_rejected", "message rejected by the PHI/secret filter", verdict.rule);
    }
    return applied;
  }

  private assertArtifacts(value: unknown): void {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      const path = asString(asObject(item).path);
      if (!path) continue;
      const verdict = filterPath(path);
      if (!verdict.ok) {
        this.archive.append({ src: "ubus", event: "rejected", essential: true, rec: { reason: "secret_path", rule: verdict.rule, path_sha256: verdict.sha256 } });
        throw new BusError("denied_secret_path", undefined, verdict.rule);
      }
    }
  }

  private rejectKioskIn(value: unknown): void {
    const visit = (v: unknown) => {
      if (typeof v === "string") {
        if (addressDenied(v) || isDeniedMachine(v)) throw new BusError("denied_kiosk");
        const parsed = parseAddress(v);
        if (parsed && isDeniedMachine(parsed.machine)) throw new BusError("denied_kiosk");
      } else if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(visit);
    };
    visit(value);
  }

  private rejectSecretPathsIn(value: unknown): void {
    const visit = (v: unknown) => {
      if (typeof v === "string" && (v.includes("/") || v.includes("~") || v.includes("\\"))) {
        const verdict = filterPath(v);
        if (!verdict.ok) {
          this.archive.append({ src: "ubus", event: "rejected", essential: true, rec: { reason: "secret_path", rule: verdict.rule, path_sha256: verdict.sha256 } });
          throw new BusError("denied_secret_path", undefined, verdict.rule);
        }
      } else if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(visit);
    };
    visit(value);
  }

  private consumeSend(sender: AgentRow): void {
    const lim = this.config.limits;
    const override = Object.prototype.hasOwnProperty.call(lim.handleSendsPerHour, sender.handle) ? lim.handleSendsPerHour[sender.handle] : undefined;
    this.consumeRate("send", sender.handle, override ?? lim.sendsPerHour);
    this.consumeRate("send", `machine:${sender.machine}`, lim.machineSendsPerHour);
  }

  private consumeRate(bucket: string, key: string, limit: number): void {
    const start = new Date(this.clock.now() - HOUR_MS).toISOString();
    const n = this.store.countRate(bucket, key, start);
    if (n >= limit) throw new BusError("rate_limited");
    this.store.addRate(bucket, key, this.clock.iso());
  }

  private hasGrant(grantee: string, handle: string, address: string, verb: string): boolean {
    return this.store.matchingGrants(grantee, this.clock.iso()).some((g) => g.verbs.includes(verb) && (g.target === handle || g.target === address));
  }

  private agentByTarget(target: string): AgentRow | undefined {
    const parsed = parseAddress(target);
    if (parsed) {
      return this.store.listAgents().find((a) => a.machine === parsed.machine && a.runtime === parsed.runtime && a.session === parsed.session && !a.closed);
    }
    const agent = this.store.getAgent(target);
    return agent && !agent.closed ? agent : undefined;
  }

  private describeTarget(addressOrHandle: string): { handle: string; address: string; owner: string; pane: boolean; presence: string } {
    if (addressDenied(addressOrHandle)) throw new BusError("denied_kiosk");
    const parsed = parseAddress(addressOrHandle);
    const agent = parsed
      ? this.store.listAgents().find((a) => a.machine === parsed.machine && a.runtime === parsed.runtime && a.session === parsed.session && !a.closed)
      : this.store.getAgent(addressOrHandle);
    const herdr = this.herdr.listAgents().find((a) => a.name === (agent?.handle || addressOrHandle) || a.name === addressOrHandle);
    const handle = agent?.handle || herdr?.name || addressOrHandle;
    const pane = !!(agent?.session.startsWith("herdr:") || herdr);
    const machine = agent?.machine || herdr?.machine || parsed?.machine || "mini";
    const runtime = agent?.runtime || herdr?.runtime || parsed?.runtime || "other";
    const session = agent?.session || (herdr ? `herdr:${herdr.herdrSession}/${herdr.name}` : parsed?.session || handle);
    return {
      handle,
      address: agent?.address || formatAddress(machine, runtime, session),
      owner: agent?.owner || herdr?.owner || "fable",
      pane,
      presence: agent ? this.presenceOf(agent) : herdr ? "live (discovered)" : "unknown",
    };
  }

  private fromEnvelope(sender: AgentRow): Record<string, unknown> {
    return {
      handle: sender.handle,
      label: displayLabel(sender.machine, sender.handle),
      machine: sender.machine,
      machine_verified: sender.machineVerified === 1,
      label_machine_mismatch: sender.labelMachineMismatch === 1,
      runtime: sender.runtime,
      via: sender.via || "local",
      platform_class: sender.platformClass || undefined,
    };
  }

  private envelopeRec(message: MessageRow): Record<string, unknown> {
    return {
      schema: SCHEMA_MSG,
      id: message.id,
      ts: message.ts,
      from: JSON.parse(message.fromJson || "{}"),
      to: JSON.parse(message.toJson || "[]"),
      subject: message.subject,
      body_sha256: message.bodySha256,
      thread_id: message.threadId,
      reply_to: message.replyTo || null,
      kind: message.kind,
      phi: JSON.parse(message.phiJson || "{}"),
      delivery: JSON.parse(message.deliveryJson || "[]"),
    };
  }

  private callerFrom(agent: AgentRow): Caller {
    return {
      handle: agent.handle,
      machine: agent.machine,
      machineVerified: agent.machineVerified === 1,
      via: (agent.via as Caller["via"]) || "local",
      platformClass: agent.platformClass || undefined,
    };
  }

  private normalizeTo(value: unknown): string[] {
    if (typeof value === "string" && value.trim()) return [value.trim()];
    if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
    return [];
  }

  private readGroups(): Record<string, GroupDef> {
    const loaded = this.loadGroups();
    if (loaded.mtime !== this.groupsMtime) {
      this.groups = loaded.defs;
      this.groupsMtime = loaded.mtime;
    }
    return this.groups;
  }

  private expandGroup(name: string, sender: Caller, ignoreGate: boolean): string[] {
    const defs = this.readGroups();
    const def = defs[name];
    if (!def) throw new BusError("unknown_agent", name);
    if (!ignoreGate && def.restricted) {
      const allowed = new Set([...this.config.approvers.engineering, ...this.config.approvers.elevated]);
      if (!sender.handle || !allowed.has(sender.handle)) throw new BusError("forbidden");
    }
    if (!ignoreGate && def.owner_gated_grok && sender.handle && isGrokHandle(sender.handle)) {
      throw new BusError("owner_gated");
    }
    return this.membersOf(name, def, sender);
  }

  private membersOf(name: string, def: GroupDef, _sender: Caller | null): string[] {
    if (def.dynamic === "grok") {
      return this.store
        .listAgents()
        .filter((a) => !a.closed && isGrokHandle(a.handle) && this.presenceOf(a) !== "gone")
        .map((a) => a.handle);
    }
    if (def.dynamic === "panes") {
      const machine = def.machine || "";
      const names = new Set<string>();
      for (const a of this.herdr.listAgents()) if (!machine || a.machine === machine) names.add(a.name);
      for (const a of this.store.listAgents()) {
        if (a.closed || !a.session.startsWith("herdr:")) continue;
        if (machine && a.machine !== machine) continue;
        names.add(a.handle);
      }
      return [...names];
    }
    if (def.dynamic === "all") {
      return this.store
        .listAgents()
        .filter((a) => !a.closed && a.handle !== "ubus" && a.handle !== STEWARD && this.presenceOf(a) !== "gone")
        .map((a) => a.handle);
    }
    return [...(def.members ?? [])];
  }

  private logPresence(agent: AgentRow, event: string): void {
    this.archive.append({
      src: "ubus",
      event,
      essential: true,
      rec: { handle: agent.handle, machine: agent.machine, runtime: agent.runtime, presence: this.presenceOf(agent), address: agent.address },
    });
  }

  private reapPresence(): void {
    for (const agent of this.store.listAgents()) {
      if (agent.closed) continue;
      const next = this.presenceOf(agent);
      if (next === "gone" && agent.presence !== "gone") {
        agent.presence = "gone";
        this.store.upsertAgent(agent);
        this.logPresence(agent, "presence");
      } else if (next !== agent.presence && next !== "gone") {
        agent.presence = next;
        this.store.upsertAgent(agent);
      }
    }
  }

  private wakeWaiter(handle: string): void {
    const list = this.waiters.get(handle) ?? [];
    this.waiters.set(handle, []);
    for (const fn of list) fn();
  }

  private wakeCorr(corrId: string): void {
    const list = this.corrWaiters.get(corrId) ?? [];
    this.corrWaiters.set(corrId, []);
    for (const fn of list) fn();
  }

  private notRegWindows = new Map<string, NotRegWindow>();

  private writeAudit(tool: string, caller: Caller, args: Record<string, unknown>, result: ToolResult): void {
    if (!result.ok && result.error === "not_registered") {
      this.noteNotRegistered(tool, caller, args);
      return;
    }
    const target = asString(args.to) || asString(args.address) || asString(args.name) || asString(args.group) || asString(args.approval_id) || "";
    this.appendAudit({
      ts: this.clock.iso(),
      handle: caller.handle ?? "",
      machine: caller.machine,
      via: caller.via,
      tool,
      target: typeof args.to === "object" ? JSON.stringify(args.to) : target,
      args_sha256: sha256(canonical(redactArgs(args))),
      result: result.ok ? "ok" : result.error || "error",
      approval_id: typeof result.approval_id === "string" ? result.approval_id : asString(args.approval_id) || null,
      ...(typeof result.rule === "string" ? { rule: result.rule } : {}),
    });
  }

  /** Repeated not_registered from one caller+tool becomes one line per minute, with a count. */
  private noteNotRegistered(tool: string, caller: Caller, args: Record<string, unknown>): void {
    const now = this.clock.now();
    const key = notRegKey(caller, tool);
    const existing = this.notRegWindows.get(key);
    if (existing && now - existing.windowStart < 60_000) {
      existing.count += 1;
      return;
    }
    if (existing) this.flushNotRegistered(key, existing);
    const target = asString(args.to) || asString(args.address) || asString(args.name) || asString(args.group) || "";
    this.notRegWindows.set(key, {
      windowStart: now,
      count: 1,
      tool,
      caller,
      target: typeof args.to === "object" ? JSON.stringify(args.to) : target,
      argsSha: sha256(canonical(redactArgs(args))),
    });
  }

  private flushNotRegisteredWindows(): void {
    const now = this.clock.now();
    for (const [key, win] of [...this.notRegWindows.entries()]) {
      if (now - win.windowStart >= 60_000) this.flushNotRegistered(key, win);
    }
  }

  private flushNotRegistered(key: string, win: NotRegWindow): void {
    this.notRegWindows.delete(key);
    this.appendAudit({
      ts: this.clock.iso(),
      handle: win.caller.handle ?? "",
      machine: win.caller.machine,
      via: win.caller.via,
      tool: win.tool,
      target: win.target,
      args_sha256: win.argsSha,
      result: "not_registered",
      approval_id: null,
      count: win.count,
      client: win.caller.client ?? "",
      user_agent: win.caller.userAgent ?? "",
      auth_class: win.caller.platformClass ?? "",
      remote: win.caller.remote ?? "",
    });
  }

  private appendAudit(line: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(this.config.auditPath), { recursive: true, mode: 0o700 });
      appendFileSync(this.config.auditPath, JSON.stringify(line) + "\n", { mode: 0o600 });
    } catch {
      /* audit must not break the call */
    }
    const tool = typeof line.tool === "string" ? line.tool : "";
    this.archive.append({
      src: "audit",
      event: tool === "ubus_agent_read" || tool === "ubus_inbox" ? "read" : "call",
      essential: tool !== "ubus_agent_read" && tool !== "ubus_inbox",
      rec: line,
    });
  }
}

interface NotRegWindow {
  windowStart: number;
  count: number;
  tool: string;
  caller: Caller;
  target: string;
  argsSha: string;
}

function notRegKey(caller: Caller, tool: string): string {
  return [
    caller.handle ?? "",
    caller.client ?? "",
    caller.userAgent ?? "",
    caller.platformClass ?? "",
    caller.remote ?? "",
    caller.via,
    caller.machine,
    tool,
  ].join("\n");
}

const STATELESS_CLASS = new Set<string>(STATELESS_PLATFORM_CLASSES);

function classAllowsResume(callerClass: string | undefined, agentClass: string): boolean {
  const cls = callerClass || "";
  if (!STATELESS_CLASS.has(cls)) return true;
  return agentClass === cls;
}

interface IdentityHint {
  handle: string;
  machine: string;
  runtime: string;
  session: string;
}

function identityHint(args: Record<string, unknown>): IdentityHint {
  let handle = asString(args.handle);
  let machine = asString(args.machine);
  let runtime = asString(args.runtime);
  let session = asString(args.session);
  const from = args.from;
  if (typeof from === "string") {
    if (!handle) handle = from;
  } else if (from && typeof from === "object" && !Array.isArray(from)) {
    const rec = from as Record<string, unknown>;
    if (!handle) handle = asString(rec.handle);
    if (!machine) machine = asString(rec.machine);
    if (!runtime) runtime = asString(rec.runtime);
    if (!session) session = asString(rec.session);
  }
  return { handle, machine, runtime, session };
}

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === "body" || k === "text" || k === "question" || k === "reason") out[k] = typeof v === "string" ? sha256(v) : null;
    else out[k] = v;
  }
  return out;
}

function compareId(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}


/** Server-owned rows (the ubus process itself) never expire. */
function isSystem(agent: AgentRow): boolean {
  try {
    return (JSON.parse(agent.capabilitiesJson || "{}") as { system?: unknown }).system === true;
  } catch {
    return false;
  }
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text || "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function clientVersionOf(agent: AgentRow): string {
  const v = parseJson(agent.capabilitiesJson).client_version;
  return typeof v === "string" ? v : "";
}
