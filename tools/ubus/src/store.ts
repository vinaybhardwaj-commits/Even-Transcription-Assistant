import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { all, get, num, openDb, run, str, type Sql } from "./sqlite.js";

export interface AgentRow {
  handle: string;
  machine: string;
  runtime: string;
  session: string;
  owner: string;
  orchestrator: string;
  capabilitiesJson: string;
  address: string;
  presence: string;
  discovered: number;
  closed: number;
  lastHeartbeatAt: string;
  lastTurnAt: string;
  registeredAt: string;
  via: string;
  machineVerified: number;
  platformClass: string;
  labelMachineMismatch: number;
  inboxCursor: number;
}

export interface DeliveryRow {
  id: number;
  messageId: string;
  toHandle: string;
  status: string;
  createdAt: string;
  readAt: string;
  ackedAt: string;
  ackNote: string;
  forPane: string;
}

export interface MessageRow {
  id: string;
  ts: string;
  threadId: string;
  replyTo: string;
  fromHandle: string;
  fromJson: string;
  toJson: string;
  ccJson: string;
  groupName: string;
  subject: string;
  body: string;
  bodySha256: string;
  kind: string;
  corrJson: string;
  priority: string;
  wake: number;
  artifactsJson: string;
  bridgeJson: string;
  phiJson: string;
  deliveryJson: string;
  idempotencyKey: string;
}

function agent(row: Record<string, unknown>): AgentRow {
  return {
    handle: str(row, "handle"),
    machine: str(row, "machine"),
    runtime: str(row, "runtime"),
    session: str(row, "session"),
    owner: str(row, "owner"),
    orchestrator: str(row, "orchestrator"),
    capabilitiesJson: str(row, "capabilities_json"),
    address: str(row, "address"),
    presence: str(row, "presence"),
    discovered: num(row, "discovered"),
    closed: num(row, "closed"),
    lastHeartbeatAt: str(row, "last_heartbeat_at"),
    lastTurnAt: str(row, "last_turn_at"),
    registeredAt: str(row, "registered_at"),
    via: str(row, "via"),
    machineVerified: num(row, "machine_verified"),
    platformClass: str(row, "platform_class"),
    labelMachineMismatch: num(row, "label_machine_mismatch"),
    inboxCursor: num(row, "inbox_cursor"),
  };
}

function message(row: Record<string, unknown>): MessageRow {
  return {
    id: str(row, "id"),
    ts: str(row, "ts"),
    threadId: str(row, "thread_id"),
    replyTo: str(row, "reply_to"),
    fromHandle: str(row, "from_handle"),
    fromJson: str(row, "from_json"),
    toJson: str(row, "to_json"),
    ccJson: str(row, "cc_json"),
    groupName: str(row, "group_name"),
    subject: str(row, "subject"),
    body: str(row, "body"),
    bodySha256: str(row, "body_sha256"),
    kind: str(row, "kind"),
    corrJson: str(row, "corr_json"),
    priority: str(row, "priority"),
    wake: num(row, "wake"),
    artifactsJson: str(row, "artifacts_json"),
    bridgeJson: str(row, "bridge_json"),
    phiJson: str(row, "phi_json"),
    deliveryJson: str(row, "delivery_json"),
    idempotencyKey: str(row, "idempotency_key"),
  };
}

function delivery(row: Record<string, unknown>): DeliveryRow {
  return {
    id: num(row, "id"),
    messageId: str(row, "message_id"),
    toHandle: str(row, "to_handle"),
    status: str(row, "status"),
    createdAt: str(row, "created_at"),
    readAt: str(row, "read_at"),
    ackedAt: str(row, "acked_at"),
    ackNote: str(row, "ack_note"),
    forPane: str(row, "for_pane"),
  };
}

export class Store {
  readonly db: Sql;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = openDb(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private txDepth = 0;

  /** Runs fn in one SQLite transaction. Nested calls join the outer one. A throw rolls everything back. */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth = 1;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw err;
    } finally {
      this.txDepth = 0;
    }
  }

  getAgent(handle: string): AgentRow | undefined {
    const row = get(this.db, "SELECT * FROM agents WHERE handle = ?", handle);
    return row ? agent(row) : undefined;
  }

  getAgentBySession(machine: string, runtime: string, session: string): AgentRow | undefined {
    const row = get(
      this.db,
      "SELECT * FROM agents WHERE machine = ? AND runtime = ? AND session = ?",
      machine,
      runtime,
      session,
    );
    return row ? agent(row) : undefined;
  }

  listAgents(): AgentRow[] {
    return all(this.db, "SELECT * FROM agents ORDER BY handle").map(agent);
  }

  /**
   * Soft removal. The row moves to agents_archive in one transaction and is not deleted from history.
   * Nothing in ubus hard-deletes an agent row; the live table row is removed only after the archive copy exists.
   */
  archiveAgent(handle: string, archivedAt: string): boolean {
    const row = get(this.db, "SELECT * FROM agents WHERE handle = ?", handle);
    if (!row) return false;
    this.db.exec("BEGIN");
    try {
      run(
        this.db,
        `INSERT INTO agents_archive (
          handle, machine, runtime, session, owner, orchestrator, capabilities_json, address,
          presence, discovered, closed, last_heartbeat_at, last_turn_at, registered_at, via,
          machine_verified, platform_class, label_machine_mismatch, inbox_cursor, archived_at
        ) SELECT handle, machine, runtime, session, owner, orchestrator, capabilities_json, address,
          presence, discovered, closed, last_heartbeat_at, last_turn_at, registered_at, via,
          machine_verified, platform_class, label_machine_mismatch, inbox_cursor, ? FROM agents WHERE handle = ?`,
        archivedAt,
        handle,
      );
      run(this.db, "DELETE FROM agents WHERE handle = ?", handle);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return true;
  }

  /** Newest archived row for a machine/runtime/session, if any. */
  getArchivedBySession(machine: string, runtime: string, session: string): AgentRow | undefined {
    const row = get(
      this.db,
      "SELECT * FROM agents_archive WHERE machine = ? AND runtime = ? AND session = ? ORDER BY id DESC LIMIT 1",
      machine,
      runtime,
      session,
    );
    return row ? agent(row) : undefined;
  }

  /** Move the newest archive row for this session back to agents. Returns it, or undefined. */
  reviveFromArchive(machine: string, runtime: string, session: string, ts: string): AgentRow | undefined {
    const arch = get(
      this.db,
      "SELECT * FROM agents_archive WHERE machine = ? AND runtime = ? AND session = ? ORDER BY id DESC LIMIT 1",
      machine,
      runtime,
      session,
    );
    if (!arch) return undefined;
    const row = agent(arch);
    if (this.getAgent(row.handle)) return undefined;
    this.upsertAgent(row);
    run(this.db, "UPDATE agents_archive SET revived_at = ? WHERE id = ?", ts, num(arch, "id"));
    return row;
  }

  archivedCount(): number {
    return num(get(this.db, "SELECT COUNT(*) AS n FROM agents_archive") ?? {}, "n");
  }

  /** Rename an agent row (used when a pane-id handle gets a real name). Mail follows the handle. */
  renameAgent(oldHandle: string, newHandle: string): void {
    run(this.db, "UPDATE agents SET handle = ? WHERE handle = ?", newHandle, oldHandle);
    run(this.db, "UPDATE deliveries SET to_handle = ? WHERE to_handle = ?", newHandle, oldHandle);
  }

  upsertBinding(b: { sessionId: string; handle: string; machine: string; via: string; platformClass: string }, ts: string): void {
    run(
      this.db,
      `INSERT INTO session_bindings (session_id, handle, machine, via, platform_class, created_at, last_seen_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET handle=excluded.handle, machine=excluded.machine,
         via=excluded.via, platform_class=excluded.platform_class, last_seen_at=excluded.last_seen_at`,
      b.sessionId,
      b.handle,
      b.machine,
      b.via,
      b.platformClass,
      ts,
      ts,
    );
  }

  getBinding(sessionId: string): { sessionId: string; handle: string; machine: string; via: string; platformClass: string } | undefined {
    const row = get(this.db, "SELECT * FROM session_bindings WHERE session_id = ?", sessionId);
    if (!row) return undefined;
    return { sessionId, handle: str(row, "handle"), machine: str(row, "machine"), via: str(row, "via"), platformClass: str(row, "platform_class") };
  }

  touchBinding(sessionId: string, ts: string): void {
    run(this.db, "UPDATE session_bindings SET last_seen_at = ? WHERE session_id = ?", ts, sessionId);
  }

  /** Bindings are rebind hints, not records: unseen ones are dropped. */
  pruneBindings(cutoffIso: string): number {
    return run(this.db, "DELETE FROM session_bindings WHERE last_seen_at < ?", cutoffIso).changes;
  }

  bindingCount(): number {
    return num(get(this.db, "SELECT COUNT(*) AS n FROM session_bindings") ?? {}, "n");
  }

  upsertAgent(a: AgentRow): void {
    run(
      this.db,
      `INSERT INTO agents (
        handle, machine, runtime, session, owner, orchestrator, capabilities_json, address,
        presence, discovered, closed, last_heartbeat_at, last_turn_at, registered_at, via,
        machine_verified, platform_class, label_machine_mismatch, inbox_cursor
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(handle) DO UPDATE SET
        machine=excluded.machine, runtime=excluded.runtime, session=excluded.session,
        owner=excluded.owner, orchestrator=excluded.orchestrator,
        capabilities_json=excluded.capabilities_json, address=excluded.address,
        presence=excluded.presence, discovered=excluded.discovered, closed=excluded.closed,
        last_heartbeat_at=excluded.last_heartbeat_at, last_turn_at=excluded.last_turn_at,
        via=excluded.via, machine_verified=excluded.machine_verified,
        platform_class=excluded.platform_class, label_machine_mismatch=excluded.label_machine_mismatch`,
      a.handle,
      a.machine,
      a.runtime,
      a.session,
      a.owner,
      a.orchestrator,
      a.capabilitiesJson,
      a.address,
      a.presence,
      a.discovered,
      a.closed,
      a.lastHeartbeatAt,
      a.lastTurnAt,
      a.registeredAt,
      a.via,
      a.machineVerified,
      a.platformClass,
      a.labelMachineMismatch,
      a.inboxCursor,
    );
  }

  insertMessage(m: MessageRow): void {
    run(
      this.db,
      `INSERT INTO messages (
        id, ts, thread_id, reply_to, from_handle, from_json, to_json, cc_json, group_name,
        subject, body, body_sha256, kind, corr_json, priority, wake, artifacts_json,
        bridge_json, phi_json, delivery_json, idempotency_key
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      m.id,
      m.ts,
      m.threadId,
      m.replyTo,
      m.fromHandle,
      m.fromJson,
      m.toJson,
      m.ccJson,
      m.groupName,
      m.subject,
      m.body,
      m.bodySha256,
      m.kind,
      m.corrJson,
      m.priority,
      m.wake,
      m.artifactsJson,
      m.bridgeJson,
      m.phiJson,
      m.deliveryJson,
      m.idempotencyKey,
    );
  }

  getMessage(id: string): MessageRow | undefined {
    const row = get(this.db, "SELECT * FROM messages WHERE id = ?", id);
    return row ? message(row) : undefined;
  }

  updateMessageDelivery(id: string, deliveryJson: string): void {
    run(this.db, "UPDATE messages SET delivery_json = ? WHERE id = ?", deliveryJson, id);
  }

  updateMessageCorr(id: string, corrJson: string, kind: string): void {
    run(this.db, "UPDATE messages SET corr_json = ?, kind = ? WHERE id = ?", corrJson, kind, id);
  }

  updateMessageBridge(id: string, bridgeJson: string): void {
    run(this.db, "UPDATE messages SET bridge_json = ? WHERE id = ?", bridgeJson, id);
  }

  threadMessages(threadId: string): MessageRow[] {
    return all(this.db, "SELECT * FROM messages WHERE thread_id = ? ORDER BY ts, id", threadId).map(message);
  }

  insertDelivery(d: Omit<DeliveryRow, "id" | "readAt" | "ackedAt" | "ackNote"> & { readAt?: string; ackedAt?: string; ackNote?: string }): number {
    return run(
      this.db,
      `INSERT INTO deliveries (message_id, to_handle, status, created_at, read_at, acked_at, ack_note, for_pane)
       VALUES (?,?,?,?,?,?,?,?)`,
      d.messageId,
      d.toHandle,
      d.status,
      d.createdAt,
      d.readAt ?? "",
      d.ackedAt ?? "",
      d.ackNote ?? "",
      d.forPane,
    ).lastId;
  }

  inbox(handle: string, opts: { unreadOnly: boolean; threadId?: string; limit: number }): Array<DeliveryRow & { message: MessageRow }> {
    const rows = all(
      this.db,
      `SELECT d.*, m.id AS mid FROM deliveries d
       JOIN messages m ON m.id = d.message_id
       WHERE d.to_handle = ?
         AND d.status IN ('stored','stored_poll','hook_pending','nudged','lead_routed')
         AND (? = 0 OR d.read_at = '')
         AND (? = '' OR m.thread_id = ?)
       ORDER BY d.id DESC
       LIMIT ?`,
      handle,
      opts.unreadOnly ? 1 : 0,
      opts.threadId ?? "",
      opts.threadId ?? "",
      opts.limit,
    );
    const out: Array<DeliveryRow & { message: MessageRow }> = [];
    for (const row of rows) {
      const msg = this.getMessage(str(row, "message_id"));
      if (!msg) continue;
      out.push({ ...delivery(row), message: msg });
    }
    return out.reverse();
  }

  /** One definition of "unread": the delivery has a message row. Count and ids both use it. */
  private static UNREAD_FROM = `FROM deliveries d JOIN messages m ON m.id = d.message_id
       WHERE d.to_handle = ? AND d.read_at = ''
         AND d.status IN ('stored','stored_poll','hook_pending','nudged','lead_routed')`;

  unreadCount(handle: string): number {
    const row = get(this.db, `SELECT COUNT(*) AS n ${Store.UNREAD_FROM}`, handle);
    return row ? num(row, "n") : 0;
  }

  unreadIds(handle: string, limit = 20): { ids: string[]; from: string[] } {
    const rows = all(this.db, `SELECT d.message_id, m.from_handle ${Store.UNREAD_FROM} ORDER BY d.id ASC LIMIT ?`, handle, limit);
    return {
      ids: rows.map((r) => str(r, "message_id")),
      from: rows.map((r) => str(r, "from_handle")),
    };
  }

  /** Deliveries whose message row is missing and that are not yet marked read. */
  orphanDeliveries(): Array<{ id: number; messageId: string; toHandle: string }> {
    return all(
      this.db,
      `SELECT d.id AS id, d.message_id AS message_id, d.to_handle AS to_handle FROM deliveries d
       LEFT JOIN messages m ON m.id = d.message_id
       WHERE m.id IS NULL AND d.read_at = ''`,
    ).map((r) => ({ id: num(r, "id"), messageId: str(r, "message_id"), toHandle: str(r, "to_handle") }));
  }

  /** Marks read with a reason in ack_note. Never deletes. */
  markOrphanRead(deliveryId: number, ts: string, reason: string): void {
    run(this.db, "UPDATE deliveries SET read_at = ?, ack_note = ? WHERE id = ? AND read_at = ''", ts, reason, deliveryId);
  }

  orphanMarkedCount(): number {
    const row = get(this.db, "SELECT COUNT(*) AS n FROM deliveries WHERE ack_note LIKE 'orphan:%'");
    return row ? num(row, "n") : 0;
  }

  markRead(handle: string, messageIds: string[], ts: string): void {
    for (const id of messageIds) {
      run(this.db, "UPDATE deliveries SET read_at = ? WHERE to_handle = ? AND message_id = ? AND read_at = ''", ts, handle, id);
    }
  }

  markAck(handle: string, messageId: string, ts: string, note: string): boolean {
    const res = run(
      this.db,
      "UPDATE deliveries SET acked_at = ? , ack_note = ? WHERE to_handle = ? AND message_id = ? AND acked_at = ''",
      ts,
      note,
      handle,
      messageId,
    );
    return res.changes > 0;
  }

  participant(threadId: string, handle: string): boolean {
    const row = get(
      this.db,
      `SELECT 1 AS ok FROM messages m
       LEFT JOIN deliveries d ON d.message_id = m.id AND d.to_handle = ?
       WHERE m.thread_id = ? AND (m.from_handle = ? OR d.id IS NOT NULL)
       LIMIT 1`,
      handle,
      threadId,
      handle,
    );
    return !!row;
  }

  putIdempotency(from: string, key: string, messageId: string, ts: string): void {
    run(
      this.db,
      `INSERT INTO idempotency (from_handle, idem_key, message_id, created_at) VALUES (?,?,?,?)
       ON CONFLICT(from_handle, idem_key) DO NOTHING`,
      from,
      key,
      messageId,
      ts,
    );
  }

  getIdempotency(from: string, key: string): { messageId: string; createdAt: string } | undefined {
    const row = get(this.db, "SELECT * FROM idempotency WHERE from_handle = ? AND idem_key = ?", from, key);
    if (!row) return undefined;
    return { messageId: str(row, "message_id"), createdAt: str(row, "created_at") };
  }

  addRate(bucket: string, key: string, ts: string): void {
    run(this.db, "INSERT INTO rate_events (bucket, subject_key, ts) VALUES (?,?,?)", bucket, key, ts);
  }

  hitRate(bucket: string, key: string, ts: string, windowStart: string, limit: number): { allowed: boolean; count: number } {
    run(this.db, "INSERT INTO rate_events (bucket, subject_key, ts) VALUES (?,?,?)", bucket, key, ts);
    const row = get(
      this.db,
      "SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND subject_key = ? AND ts >= ?",
      bucket,
      key,
      windowStart,
    );
    const count = row ? num(row, "n") : 0;
    if (count > limit) {
      return { allowed: false, count };
    }
    return { allowed: true, count };
  }

  countRate(bucket: string, key: string, windowStart: string): number {
    const row = get(
      this.db,
      "SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND subject_key = ? AND ts >= ?",
      bucket,
      key,
      windowStart,
    );
    return row ? num(row, "n") : 0;
  }

  /** Unacked inbox deliveries created at or after sinceIso, joined to what the escalation sweep needs. Ids and flags only. */
  unackedDeliveries(sinceIso: string): Array<{
    id: number;
    messageId: string;
    toHandle: string;
    createdAt: string;
    subject: string;
    kind: string;
    priority: string;
    wake: number;
    fromHandle: string;
    reqState: string;
  }> {
    return all(
      this.db,
      `SELECT d.id AS id, d.message_id AS message_id, d.to_handle AS to_handle, d.created_at AS created_at,
              m.subject AS subject, m.kind AS kind, m.priority AS priority, m.wake AS wake, m.from_handle AS from_handle,
              COALESCE((SELECT r.state FROM requests r WHERE r.message_id = m.id LIMIT 1), '') AS req_state
         FROM deliveries d JOIN messages m ON m.id = d.message_id
        WHERE COALESCE(d.acked_at, '') = '' AND d.created_at >= ?
          AND d.status IN ('stored','stored_poll','hook_pending','nudged','lead_routed')
        ORDER BY d.created_at, d.id`,
      sinceIso,
    ).map((r) => ({
      id: num(r, "id"),
      messageId: str(r, "message_id"),
      toHandle: str(r, "to_handle"),
      createdAt: str(r, "created_at"),
      subject: str(r, "subject"),
      kind: str(r, "kind"),
      priority: str(r, "priority"),
      wake: num(r, "wake"),
      fromHandle: str(r, "from_handle"),
      reqState: str(r, "req_state"),
    }));
  }

  insertEscalation(e: { deliveryId: number; recipient: string; stage: string; at: string; outcome: string }): void {
    run(this.db, "INSERT INTO escalations (delivery_id, recipient, stage, at, outcome) VALUES (?,?,?,?,?)", e.deliveryId, e.recipient, e.stage, e.at, e.outcome);
  }

  lastEscalationAt(recipient: string, stage: string): string {
    const row = get(this.db, "SELECT MAX(at) AS at FROM escalations WHERE recipient = ? AND stage = ?", recipient, stage);
    return row ? str(row, "at") : "";
  }

  /** Delivery ids that already have a row for this stage. */
  escalatedDeliveryIds(stage: string, sinceIso: string): Set<number> {
    return new Set(all(this.db, "SELECT delivery_id FROM escalations WHERE stage = ? AND at >= ? AND outcome NOT LIKE 'not_sent%'", stage, sinceIso).map((r) => num(r, "delivery_id")));
  }

  escalationCount(stage: string, recipient: string, sinceIso: string): number {
    const row = get(this.db, "SELECT COUNT(*) AS n FROM escalations WHERE stage = ? AND recipient = ? AND at >= ? AND outcome NOT LIKE 'not_sent%'", stage, recipient, sinceIso);
    return row ? num(row, "n") : 0;
  }

  escalationCounts(sinceIso: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of all(this.db, "SELECT stage, COUNT(*) AS n FROM escalations WHERE at >= ? AND outcome NOT LIKE 'not_sent%' GROUP BY stage", sinceIso)) out[str(r, "stage")] = num(r, "n");
    return out;
  }

  getState(key: string): string {
    const row = get(this.db, "SELECT value FROM escalation_state WHERE key = ?", key);
    return row ? str(row, "value") : "";
  }

  setState(key: string, value: string): void {
    run(this.db, "INSERT INTO escalation_state (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  /** The escalation_state table's own row only. */
  clearState(key: string): void {
    run(this.db, "DELETE FROM escalation_state WHERE key = ?", key);
  }

  /** The escalations table's own rows only. Nothing else is deleted. */
  pruneEscalations(cutoffIso: string): number {
    const before = get(this.db, "SELECT COUNT(*) AS n FROM escalations WHERE at < ?", cutoffIso);
    run(this.db, "DELETE FROM escalations WHERE at < ?", cutoffIso);
    return before ? num(before, "n") : 0;
  }

  lastWake(recipient: string): string {
    const row = get(this.db, "SELECT last_at FROM wake_log WHERE recipient = ?", recipient);
    return row ? str(row, "last_at") : "";
  }

  setWake(recipient: string, ts: string): void {
    run(
      this.db,
      `INSERT INTO wake_log (recipient, last_at) VALUES (?,?)
       ON CONFLICT(recipient) DO UPDATE SET last_at = excluded.last_at`,
      recipient,
      ts,
    );
  }

  lastNudge(pane: string): string {
    const row = get(this.db, "SELECT last_at FROM nudge_log WHERE pane = ?", pane);
    return row ? str(row, "last_at") : "";
  }

  setNudge(pane: string, ts: string): void {
    run(
      this.db,
      `INSERT INTO nudge_log (pane, last_at) VALUES (?,?)
       ON CONFLICT(pane) DO UPDATE SET last_at = excluded.last_at`,
      pane,
      ts,
    );
  }

  insertRequest(r: {
    corrId: string;
    threadId: string;
    fromHandle: string;
    toHandle: string;
    messageId: string;
    timeoutAt: string;
    onTimeout: string;
    state: string;
    createdAt: string;
  }): void {
    run(
      this.db,
      `INSERT INTO requests (corr_id, thread_id, from_handle, to_handle, message_id, timeout_at, on_timeout, state, response_id, created_at, retried)
       VALUES (?,?,?,?,?,?,?,?, '', ?, 0)`,
      r.corrId,
      r.threadId,
      r.fromHandle,
      r.toHandle,
      r.messageId,
      r.timeoutAt,
      r.onTimeout,
      r.state,
      r.createdAt,
    );
  }

  getRequest(corrId: string): Record<string, unknown> | undefined {
    return get(this.db, "SELECT * FROM requests WHERE corr_id = ?", corrId);
  }

  listRequests(handle: string, direction: "out" | "in", state?: string): Record<string, unknown>[] {
    const col = direction === "out" ? "from_handle" : "to_handle";
    if (state) return all(this.db, `SELECT * FROM requests WHERE ${col} = ? AND state = ? ORDER BY created_at`, handle, state);
    return all(this.db, `SELECT * FROM requests WHERE ${col} = ? ORDER BY created_at`, handle);
  }

  dueRequests(nowIso: string): Record<string, unknown>[] {
    return all(this.db, "SELECT * FROM requests WHERE state = 'pending' AND timeout_at <= ?", nowIso);
  }

  updateRequest(corrId: string, patch: { state?: string; responseId?: string; retried?: number; timeoutAt?: string }): void {
    const cur = this.getRequest(corrId);
    if (!cur) return;
    run(
      this.db,
      "UPDATE requests SET state = ?, response_id = ?, retried = ?, timeout_at = ? WHERE corr_id = ?",
      patch.state ?? str(cur, "state"),
      patch.responseId ?? str(cur, "response_id"),
      patch.retried ?? num(cur, "retried"),
      patch.timeoutAt ?? str(cur, "timeout_at"),
      corrId,
    );
  }

  insertGrant(g: { id: string; grantor: string; grantee: string; target: string; verbsJson: string; expiresAt: string; createdAt: string }): void {
    run(
      this.db,
      "INSERT INTO grants (id, grantor, grantee, target, verbs_json, expires_at, created_at) VALUES (?,?,?,?,?,?,?)",
      g.id,
      g.grantor,
      g.grantee,
      g.target,
      g.verbsJson,
      g.expiresAt,
      g.createdAt,
    );
  }

  matchingGrants(grantee: string, nowIso: string): Array<{ id: string; target: string; verbs: string[]; expiresAt: string }> {
    return all(this.db, "SELECT * FROM grants WHERE grantee = ? AND expires_at > ?", grantee, nowIso).map((row) => ({
      id: str(row, "id"),
      target: str(row, "target"),
      verbs: JSON.parse(str(row, "verbs_json") || "[]") as string[],
      expiresAt: str(row, "expires_at"),
    }));
  }

  insertApproval(a: {
    id: string;
    requester: string;
    action: string;
    argsSha256: string;
    argsCanonical: string;
    engineeringOnly: number;
    expiresAt: string;
    createdAt: string;
  }): void {
    run(
      this.db,
      `INSERT INTO approvals (id, requester, action, args_sha256, args_canonical, engineering_only, approver, state, expires_at, created_at, used_at)
       VALUES (?,?,?,?,?,?, '', 'pending', ?, ?, '')`,
      a.id,
      a.requester,
      a.action,
      a.argsSha256,
      a.argsCanonical,
      a.engineeringOnly,
      a.expiresAt,
      a.createdAt,
    );
  }

  getApproval(id: string): Record<string, unknown> | undefined {
    return get(this.db, "SELECT * FROM approvals WHERE id = ?", id);
  }

  findApproved(action: string, argsSha256: string, nowIso: string): Record<string, unknown> | undefined {
    return get(
      this.db,
      "SELECT * FROM approvals WHERE action = ? AND args_sha256 = ? AND state = 'approved' AND expires_at > ? ORDER BY created_at LIMIT 1",
      action,
      argsSha256,
      nowIso,
    );
  }

  updateApproval(id: string, patch: { state: string; approver?: string; expiresAt?: string; usedAt?: string }): void {
    const cur = this.getApproval(id);
    if (!cur) return;
    run(
      this.db,
      "UPDATE approvals SET state = ?, approver = ?, expires_at = ?, used_at = ? WHERE id = ?",
      patch.state,
      patch.approver ?? str(cur, "approver"),
      patch.expiresAt ?? str(cur, "expires_at"),
      patch.usedAt ?? str(cur, "used_at"),
      id,
    );
  }

  insertBridge(b: {
    direction: string;
    ubusMessageId: string;
    ubusThreadId: string;
    etaId: string;
    etaThreadId: string;
    identity: string;
    ubusHandle: string;
    etaParty: string;
    createdAt: string;
  }): void {
    run(
      this.db,
      `INSERT INTO bridge_links (direction, ubus_message_id, ubus_thread_id, eta_id, eta_thread_id, identity, ubus_handle, eta_party, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      b.direction,
      b.ubusMessageId,
      b.ubusThreadId,
      b.etaId,
      b.etaThreadId,
      b.identity,
      b.ubusHandle,
      b.etaParty,
      b.createdAt,
    );
  }

  findBridgeByEta(etaId: string, etaThreadId: string): Record<string, unknown> | undefined {
    if (etaId) {
      const byId = get(this.db, "SELECT * FROM bridge_links WHERE eta_id = ? ORDER BY id DESC LIMIT 1", etaId);
      if (byId) return byId;
    }
    if (etaThreadId) {
      return get(this.db, "SELECT * FROM bridge_links WHERE eta_thread_id = ? ORDER BY id DESC LIMIT 1", etaThreadId);
    }
    return undefined;
  }

  etaCursor(): string {
    const row = get(this.db, "SELECT last_seen FROM eta_cursor WHERE id = 1");
    return row ? str(row, "last_seen") : "0";
  }

  setEtaCursor(last: string): void {
    run(
      this.db,
      `INSERT INTO eta_cursor (id, last_seen) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`,
      last,
    );
  }

  seenEta(id: string): boolean {
    return !!get(this.db, "SELECT 1 AS ok FROM eta_seen WHERE eta_id = ?", id);
  }

  markEtaSeen(id: string): void {
    run(this.db, "INSERT INTO eta_seen (eta_id) VALUES (?) ON CONFLICT(eta_id) DO NOTHING", id);
  }

  enqueueBridge(row: { identity: string; toHandle: string; ubusMessageId: string; createdAt: string; forPane: string }): void {
    run(
      this.db,
      "INSERT INTO bridge_queue (identity, to_handle, ubus_message_id, created_at, posted, for_pane) VALUES (?,?,?,?,0,?)",
      row.identity,
      row.toHandle,
      row.ubusMessageId,
      row.createdAt,
      row.forPane,
    );
  }

  pendingBridge(identity: string): Array<{ id: number; toHandle: string; ubusMessageId: string; forPane: string }> {
    return all(this.db, "SELECT * FROM bridge_queue WHERE identity = ? AND posted = 0 ORDER BY id", identity).map((row) => ({
      id: num(row, "id"),
      toHandle: str(row, "to_handle"),
      ubusMessageId: str(row, "ubus_message_id"),
      forPane: str(row, "for_pane"),
    }));
  }

  markBridgePosted(ids: number[]): void {
    for (const id of ids) run(this.db, "UPDATE bridge_queue SET posted = 1 WHERE id = ?", id);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  handle TEXT PRIMARY KEY,
  machine TEXT NOT NULL,
  runtime TEXT NOT NULL,
  session TEXT NOT NULL,
  owner TEXT NOT NULL,
  orchestrator TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  address TEXT NOT NULL,
  presence TEXT NOT NULL,
  discovered INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at TEXT,
  last_turn_at TEXT,
  registered_at TEXT NOT NULL,
  via TEXT,
  machine_verified INTEGER NOT NULL DEFAULT 0,
  platform_class TEXT,
  label_machine_mismatch INTEGER NOT NULL DEFAULT 0,
  inbox_cursor INTEGER NOT NULL DEFAULT 0,
  UNIQUE(machine, runtime, session)
);
CREATE TABLE IF NOT EXISTS session_bindings (
  session_id TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  machine TEXT NOT NULL,
  via TEXT,
  platform_class TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bind_seen ON session_bindings(last_seen_at);
CREATE TABLE IF NOT EXISTS agents_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL,
  machine TEXT NOT NULL,
  runtime TEXT NOT NULL,
  session TEXT NOT NULL,
  owner TEXT NOT NULL,
  orchestrator TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  address TEXT NOT NULL,
  presence TEXT NOT NULL,
  discovered INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at TEXT,
  last_turn_at TEXT,
  registered_at TEXT NOT NULL,
  via TEXT,
  machine_verified INTEGER NOT NULL DEFAULT 0,
  platform_class TEXT,
  label_machine_mismatch INTEGER NOT NULL DEFAULT 0,
  inbox_cursor INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT NOT NULL,
  revived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_arch_handle ON agents_archive(handle);
CREATE INDEX IF NOT EXISTS idx_arch_session ON agents_archive(machine, runtime, session);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  reply_to TEXT,
  from_handle TEXT NOT NULL,
  from_json TEXT NOT NULL,
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL,
  group_name TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  kind TEXT NOT NULL,
  corr_json TEXT,
  priority TEXT NOT NULL,
  wake INTEGER NOT NULL DEFAULT 0,
  artifacts_json TEXT,
  bridge_json TEXT,
  phi_json TEXT NOT NULL,
  delivery_json TEXT NOT NULL,
  idempotency_key TEXT
);
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  to_handle TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  acked_at TEXT,
  ack_note TEXT,
  for_pane TEXT
);
CREATE INDEX IF NOT EXISTS idx_del_to ON deliveries(to_handle, read_at);
CREATE TABLE IF NOT EXISTS requests (
  corr_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  from_handle TEXT NOT NULL,
  to_handle TEXT NOT NULL,
  message_id TEXT NOT NULL,
  timeout_at TEXT NOT NULL,
  on_timeout TEXT NOT NULL,
  state TEXT NOT NULL,
  response_id TEXT,
  created_at TEXT NOT NULL,
  retried INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  grantor TEXT NOT NULL,
  grantee TEXT NOT NULL,
  target TEXT NOT NULL,
  verbs_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  requester TEXT NOT NULL,
  action TEXT NOT NULL,
  args_sha256 TEXT NOT NULL,
  args_canonical TEXT NOT NULL,
  engineering_only INTEGER NOT NULL,
  approver TEXT,
  state TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS rate_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate ON rate_events(bucket, subject_key, ts);
CREATE TABLE IF NOT EXISTS idempotency (
  from_handle TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_handle, idem_key)
);
CREATE TABLE IF NOT EXISTS bridge_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL,
  ubus_message_id TEXT NOT NULL,
  ubus_thread_id TEXT NOT NULL,
  eta_id TEXT NOT NULL,
  eta_thread_id TEXT NOT NULL,
  identity TEXT NOT NULL,
  ubus_handle TEXT NOT NULL,
  eta_party TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS eta_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS eta_seen (
  eta_id TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS wake_log (
  recipient TEXT PRIMARY KEY,
  last_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nudge_log (
  pane TEXT PRIMARY KEY,
  last_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS escalation_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS escalations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id INTEGER NOT NULL,
  recipient TEXT NOT NULL,
  stage TEXT NOT NULL,
  at TEXT NOT NULL,
  outcome TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_esc_rec ON escalations(recipient, stage, at);
CREATE INDEX IF NOT EXISTS idx_del_created ON deliveries(created_at);
CREATE TABLE IF NOT EXISTS bridge_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity TEXT NOT NULL,
  to_handle TEXT NOT NULL,
  ubus_message_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  posted INTEGER NOT NULL DEFAULT 0,
  for_pane TEXT
);
`;
