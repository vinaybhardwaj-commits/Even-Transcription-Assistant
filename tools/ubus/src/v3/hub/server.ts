import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Caller } from "../../bus.js";
import { SystemClock, type Clock } from "../../util.js";
import { Hub, openHub, v3Enabled } from "../hub.js";
import { authenticate, NonceCache } from "./auth.js";
import { assertBindable, isLoopback, type HubServerConfig } from "./config.js";
import { ALERT_FAILED, ALERT_SENT, ALERT_SKIPPED, EPOCH_RESET, EV_PREFIX, REJECTED_KIND, Registry } from "./registry.js";
import { checkEvent, digitCount, EPOCH_RE, MAX_BATCH, MAX_NUMBER_DIGITS, type NodeEvent } from "./validate.js";

const MAX_BODY_BYTES = 2_000_000;
const ALERT_STATES = new Set(["errored", "stalled"]);
const ALERT_SENDER = "ubus-hub";
const ALERT_THREAD = "alert-";

export interface IngestResult {
  epoch: string | null;
  ack_seq: number;
  stored: number;
  duplicates: number;
  /** seq is null when it was not a usable integer (never echoed back). */
  rejected: Array<{ seq: number | null; rule: string }>;
}

/** The hub side of P1: node-authenticated ingest into the P0 event log, plus read-only views. */
export class HubServer {
  readonly hub: Hub;
  readonly registry = new Registry();
  private readonly nonces = new NonceCache();
  /** Requests stamped before this are refused, so nothing captured before a restart can be replayed after it. */
  private readonly bootMs: number;
  private server: Server | null = null;

  constructor(
    readonly cfg: HubServerConfig,
    readonly clock: Clock = new SystemClock(),
  ) {
    if (!v3Enabled()) throw new Error("ubus v3 is off (UBUS_V3=1 to enable)");
    assertBindable(cfg.listen.host);
    this.hub = openHub({ dbPath: cfg.dbPath, clock, allowlistPath: cfg.allowlistPath });
    for (const row of this.hub.log.all()) this.registry.apply(row);
    this.bootMs = clock.now();
    this.flushAlerts(true);
  }

  /** Validate and store one node's batch. Idempotent on (node, epoch, seq). */
  ingest(node: string, raw: unknown[], batchEpoch: string | null = null): IngestResult {
    const res: IngestResult = { epoch: batchEpoch !== null && EPOCH_RE.test(batchEpoch) ? batchEpoch : null, ack_seq: 0, stored: 0, duplicates: 0, rejected: [] };
    for (const item of raw) {
      const o = (item ?? {}) as { seq?: unknown; epoch?: unknown };
      const epoch = typeof o.epoch === "string" && EPOCH_RE.test(o.epoch) ? o.epoch : null;
      const seq = Number.isSafeInteger(o.seq) && (o.seq as number) >= 1 && digitCount(o.seq as number) <= MAX_NUMBER_DIGITS ? (o.seq as number) : null;
      res.epoch ??= epoch;
      if (epoch && seq !== null) {
        // A seq that was rejected stays rejected: say so again so the node corrects under a new seq.
        const earlier = this.registry.rejection(node, epoch, seq);
        if (earlier) {
          res.rejected.push({ seq, rule: earlier });
          continue;
        }
      }
      const checked = checkEvent(item, this.hub.filter);
      if (epoch && !this.registry.knowsEpoch(node, epoch) && this.registry.hasEpochs(node)) {
        this.store(node, EPOCH_RESET, node, { old_epoch: this.registry.currentEpoch(node), new_epoch: epoch });
      }
      if (!checked.ok) {
        // A poison event is recorded (rule id only) so its seq is consumed and the node can trim its spool.
        if (epoch && seq !== null && !this.registry.has(node, epoch, seq)) this.store(node, REJECTED_KIND, `${node}:${seq}`, { epoch, seq, rule: checked.rule });
        res.rejected.push({ seq, rule: checked.rule });
        continue;
      }
      const ev = checked.event;
      if (this.registry.has(node, ev.epoch, ev.seq)) {
        res.duplicates++;
        continue;
      }
      this.store(node, `${EV_PREFIX}${ev.kind}`, ev.agent?.id ?? node, { epoch: ev.epoch, seq: ev.seq, ts: ev.ts, agent: ev.agent, state: ev.state, reason: ev.reason, meta: ev.meta });
      res.stored++;
    }
    this.flushAlerts(false);
    res.ack_seq = res.epoch ? this.registry.ackSeq(node, res.epoch) : 0;
    return res;
  }

  private store(node: string, kind: string, subjectId: string, meta: Record<string, unknown>): number {
    const ts = this.clock.iso();
    const id = this.hub.log.append({ ts, actor: node, kind, subjectId, meta });
    this.registry.apply({ id, ts, actor: node, kind, subjectId, bodyRef: null, meta });
    return id;
  }

  /** Lane owner from lane_owners.json: a handle, null when the lane has none; throws when the file cannot be read. */
  private laneOwner(lane: string): string | null {
    const map = JSON.parse(readFileSync(this.cfg.laneOwnersPath, "utf8")) as Record<string, unknown>;
    const owner = map[lane];
    return typeof owner === "string" && owner ? owner : null;
  }

  /**
   * Send the owed alerts: one P0 alert message each, body is ids, state and rule id only.
   * The outcome is a row naming the source event (sent / skipped / failed). A failure is
   * retried only at startup (retryFailed), so a broken owner cannot flood the log.
   */
  private flushAlerts(retryFailed: boolean): void {
    const due = this.registry.dueAlerts();
    // The alert message's thread id names its source event, so a crash between the message
    // and its hub.alert.sent row is repaired by finding the message, not by sending again.
    const sentBefore = due.length ? new Map(this.hub.messages.snapshot().messages.filter((m) => m.from === ALERT_SENDER && m.threadId.startsWith(ALERT_THREAD)).map((m) => [m.threadId, m.id])) : new Map<string, string>();
    for (const d of due) {
      if (d.failed && !retryFailed) continue;
      const outcome = (kind: string, meta: Record<string, unknown>) => this.store("ubus-hub", kind, String(d.sourceEvent), { source_event: d.sourceEvent, ...meta });
      try {
        const owner = d.lane ? this.laneOwner(d.lane) : null;
        if (!d.lane || !owner) {
          outcome(ALERT_SKIPPED, { reason: "no_owner" });
          continue;
        }
        const existing = sentBefore.get(`${ALERT_THREAD}${d.sourceEvent}`);
        if (existing) {
          outcome(ALERT_SENT, { message_id: existing });
          continue;
        }
        if (!this.hub.identity.resolve(owner)) this.hub.register(owner);
        if (!this.hub.identity.resolve(ALERT_SENDER)) this.hub.register(ALERT_SENDER);
        const caller: Caller = { handle: ALERT_SENDER, machine: "mini", machineVerified: true, via: "local" };
        const sent = this.hub.send(
          { to: owner, thread_id: `${ALERT_THREAD}${d.sourceEvent}`, kind: "alert", priority: "high", subject: `${d.lane} ${d.state}`, body: `agent=${d.agent} lane=${d.lane} state=${d.state} rule=${d.reason ?? "none"}` },
          caller,
        );
        if (sent.ok) outcome(ALERT_SENT, { message_id: String(sent.id ?? "") });
        else outcome(ALERT_FAILED, { error: String(sent.error ?? "send_failed") });
      } catch {
        outcome(ALERT_FAILED, { error: "exception" });
      }
    }
  }

  health(): Record<string, unknown> {
    return { ok: true, events: this.registry.eventCount(), nodes: this.registry.nodeSeen() };
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  }

  private readBody(req: IncomingMessage): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          resolve(null);
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", () => resolve(null));
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://hub");
    const path = url.pathname;
    const body = await this.readBody(req);
    if (!body) return this.json(res, 413, { ok: false, error: "too_large" });
    const nowMs = this.clock.now();
    const authed = () =>
      authenticate(
        this.cfg.keyDir,
        { method: req.method ?? "", pathQuery: req.url ?? "/", authorization: req.headers.authorization, ts: header(req, "x-ubus-ts"), nonce: header(req, "x-ubus-nonce"), body },
        nowMs,
        this.nonces,
        this.bootMs,
      );

    if (req.method === "POST" && path === "/api/v3/events") {
      const auth = authed();
      if (!auth.ok) return this.json(res, auth.status, { ok: false, error: auth.reason });
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        return this.json(res, 400, { ok: false, error: "bad_json" });
      }
      const events = (parsed as { events?: unknown })?.events;
      if (!Array.isArray(events) || events.length > MAX_BATCH) return this.json(res, 400, { ok: false, error: "bad_batch" });
      if (events.some((e) => (e as { node?: unknown })?.node !== auth.node)) return this.json(res, 403, { ok: false, error: "node_mismatch" });
      const first = events.find((e) => typeof (e as { epoch?: unknown })?.epoch === "string") as { epoch: string } | undefined;
      const bodyEpoch = (parsed as { epoch?: unknown }).epoch;
      const rawEpoch = first?.epoch ?? (typeof bodyEpoch === "string" ? bodyEpoch : null);
      if (events.some((e) => (e as { epoch?: unknown })?.epoch !== rawEpoch)) return this.json(res, 400, { ok: false, error: "mixed_epoch" });
      // Only a well-formed epoch is ever handed on (and so echoed); a bad one is answered by rule id alone.
      try {
        return this.json(res, 200, this.ingest(auth.node, events, rawEpoch !== null && EPOCH_RE.test(rawEpoch) ? rawEpoch : null));
      } catch {
        // A malformed batch is the sender's fault: 400, never a thrown error. Nothing about the batch is echoed.
        return this.json(res, 400, { ok: false, error: "bad_batch" });
      }
    }
    if (req.method !== "GET") return this.json(res, 405, { ok: false, error: "method_not_allowed" });

    const secured = path === "/api/v3/since" || path === "/api/v3/messages" || !isLoopback(this.cfg.listen.host);
    if (secured) {
      const auth = authed();
      if (!auth.ok) return this.json(res, auth.status, { ok: false, error: auth.reason });
    }
    if (path === "/api/v3/health") return this.json(res, 200, this.health());
    if (path === "/api/v3/agents") {
      const node = url.searchParams.get("node") ?? undefined;
      return this.json(res, 200, { agents: this.registry.agentViews(nowMs, { node }) });
    }
    if (path === "/api/v3/lanes") return this.json(res, 200, { lanes: this.registry.laneViews(nowMs, url.searchParams.get("state") ?? undefined) });
    if (path === "/api/v3/since" || path === "/api/v3/messages") {
      if (path === "/api/v3/messages") return this.json(res, 200, { messages: this.messagesView(url.searchParams.get("state") ?? undefined) });
      const cursor = Math.max(0, Number(url.searchParams.get("cursor") ?? 0) || 0);
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 1000) || 1000));
      const events = this.hub.log.all().filter((r) => r.id > cursor).slice(0, limit);
      return this.json(res, 200, { events, next_cursor: events.length ? events[events.length - 1].id : cursor });
    }
    return this.json(res, 404, { ok: false, error: "not_found" });
  }

  private messagesView(state?: string): unknown[] {
    const snap = this.hub.messages.snapshot();
    const states = new Map(snap.states);
    return snap.messages
      .map((m) => ({ id: m.id, ts: m.ts, from: m.from, kind: m.kind, priority: m.priority, subject: m.subject, to: Object.fromEntries((states.get(m.id) ?? []).map(([h, v]) => [h, v.state])) }))
      .filter((m) => {
        if (state !== "unacked") return !state || Object.values(m.to).some((v) => v === state);
        return Object.values(m.to).some((s) => s !== "acked" && s !== "done" && s !== "rejected");
      });
  }

  listen(): Promise<{ host: string; port: number }> {
    assertBindable(this.cfg.listen.host);
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => this.json(res, 500, { ok: false, error: "internal" }));
    });
    return new Promise((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.cfg.listen.port, this.cfg.listen.host, () => {
        const a = this.server!.address() as AddressInfo;
        resolve({ host: a.address, port: a.port });
      });
    });
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); });
    this.hub.close();
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export { ALERT_FAILED, ALERT_SENT, ALERT_SKIPPED, EPOCH_RESET, REJECTED_KIND };
