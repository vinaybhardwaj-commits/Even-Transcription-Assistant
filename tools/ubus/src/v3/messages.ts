import { addressDenied } from "../address.js";
import type { Caller, ToolResult } from "../bus.js";
import { isDeniedMachine } from "../constants.js";
import { createHmac } from "node:crypto";
import { asBool, asNumber, asString, bytesLen, clamp, ulid, type Clock } from "../util.js";
import type { EventInput, EventLog, EventRow } from "./eventlog.js";
import { checkFilter, checkPath, type AllowList } from "./filter.js";
import type { Identity } from "./identity.js";

export const SUBJECT_MAX_CHARS = 120;
/** Body limit in UTF-8 BYTES (not characters): 280 bytes without a body_ref. */
export const BODY_MAX_BYTES = 280;
export const KINDS = ["msg", "request", "response", "digest", "alert"] as const;
export const PRIORITIES = ["low", "normal", "high"] as const;
export const CHAIN = ["stored", "delivered", "read", "acked", "done"] as const;

export type ChainState = (typeof CHAIN)[number];
export type RecipientState = ChainState | "rejected";

export interface MsgView {
  id: string;
  ts: string;
  from: string;
  kind: string;
  priority: string;
  slaS: number;
  subject: string;
  body: string;
  bodyRef: string;
  threadId: string;
  allowTerms: string[];
}

export interface RecipientView {
  state: RecipientState;
  reason: string;
}

export type TransitionResult = { ok: true; state: RecipientState; changed: boolean } | { ok: false; error: "illegal_transition"; from: string; to: string };

function indexInChain(state: string): number {
  return (CHAIN as readonly string[]).indexOf(state);
}

/**
 * What an unknown 'to' name becomes in responses, delivery lists and the log:
 * an HMAC-SHA256 of the lower-cased, trimmed name under the hub's 0600 key
 * file, truncated to 16 hex — never the name itself (a raw name can be PHI,
 * and an unsalted digest would be enumerable).
 */
export function makeNameRef(key: Buffer | string): (name: string) => string {
  return (name: string) => `hmac:${createHmac("sha256", key).update(name.trim().toLowerCase()).digest("hex").slice(0, 16)}`;
}

export interface MessagesOptions {
  log: EventLog;
  identity: Identity;
  filter: AllowList;
  clock: Clock;
  /** HMAC-based ref for names that must not be persisted raw. */
  nameRef: (name: string) => string;
  /** True when the handle is a live recipient outside the v3 identity registry (a v1-registered agent). */
  exists?: (handle: string) => boolean;
}

/**
 * The v3 message model (§4.2): kind, priority, sla_s, subject ≤120, body ≤280
 * or a body_ref, and one state machine per recipient:
 * stored → delivered → read → acked → done, or rejected(reason).
 * Illegal transitions are refused; rejected is set only when the row is created.
 */
export class Messages {
  private messages = new Map<string, MsgView>();
  private states = new Map<string, Map<string, RecipientView>>();
  private inboxOf = new Map<string, string[]>();

  constructor(private opts: MessagesOptions) {}

  apply(event: EventRow): void {
    if (event.kind === "message.sent") {
      const m = event.meta as Record<string, unknown>;
      this.messages.set(event.subjectId, {
        id: event.subjectId,
        ts: event.ts,
        from: String(m.from ?? event.actor),
        kind: String(m.kind ?? "msg"),
        priority: String(m.priority ?? "normal"),
        slaS: Number(m.sla_s ?? 0),
        subject: String(m.subject ?? ""),
        body: String(m.body ?? ""),
        bodyRef: String(m.body_ref ?? ""),
        threadId: String(m.thread_id ?? ""),
        allowTerms: Array.isArray(m.allow_terms) ? m.allow_terms.map(String) : [],
      });
      // stored is derived from meta.to: a message row can never replay without
      // a per-recipient state, even if the log stops right after the message.
      if (Array.isArray(m.to)) {
        for (const recipient of m.to.map(String)) this.setRecipient(event.subjectId, recipient, "stored", "");
      }
      return;
    }
    if (event.kind !== "recipient.state") return;
    const m = event.meta as Record<string, unknown>;
    this.setRecipient(String(m.message_id ?? ""), event.subjectId, String(m.state ?? "") as RecipientState, String(m.reason ?? ""));
  }

  private setRecipient(messageId: string, recipient: string, state: RecipientState, reason: string): void {
    if (!messageId || !recipient) return;
    let perMessage = this.states.get(messageId);
    if (!perMessage) {
      perMessage = new Map();
      this.states.set(messageId, perMessage);
    }
    const prev = perMessage.get(recipient);
    perMessage.set(recipient, { state, reason: reason || prev?.reason || "" });
    if (state === "rejected") return;
    const list = this.inboxOf.get(recipient) ?? [];
    if (!list.includes(messageId)) {
      list.push(messageId);
      this.inboxOf.set(recipient, list);
    }
  }

  rebuild(): void {
    this.messages.clear();
    this.states.clear();
    this.inboxOf.clear();
    for (const event of this.opts.log.all()) this.apply(event);
  }

  message(id: string): MsgView | undefined {
    return this.messages.get(id);
  }

  /** Refused recipients are keyed by the HMAC ref; a raw name still resolves to that row. */
  stateOf(messageId: string, recipient: string): RecipientView | undefined {
    const per = this.states.get(messageId);
    if (!per) return undefined;
    return per.get(recipient) ?? per.get(this.opts.nameRef(recipient));
  }

  /** Sorted, JSON-safe views for replay comparison. */
  snapshot(): {
    messages: MsgView[];
    states: Array<[string, Array<[string, RecipientView]>]>;
    inbox: Array<[string, string[]]>;
  } {
    return {
      messages: [...this.messages.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      states: [...this.states.entries()]
        .map(([mid, per]) => [mid, [...per.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))] as [string, Array<[string, RecipientView]>])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
      inbox: [...this.inboxOf.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    };
  }

  /** Append one event and fold it in. Several of these may sit in one log transaction. */
  private commit(e: EventInput): void {
    this.opts.log.append(e);
    this.apply({ id: 0, ts: e.ts, actor: e.actor, kind: e.kind, subjectId: e.subjectId, bodyRef: e.bodyRef ?? null, meta: e.meta ?? {} });
  }

  private appendState(messageId: string, recipient: string, state: RecipientState, reason = ""): void {
    this.commit({
      ts: this.opts.clock.iso(),
      actor: recipient,
      kind: "recipient.state",
      subjectId: recipient,
      meta: { message_id: messageId, state, reason },
    });
  }

  /** One step along the chain, or a no-op when already there. Anything else is refused. */
  transition(messageId: string, recipient: string, to: ChainState): TransitionResult {
    const current = this.stateOf(messageId, recipient);
    if (!current) return { ok: false, error: "illegal_transition", from: "absent", to };
    if (current.state === to) return { ok: true, state: to, changed: false };
    const from = indexInChain(current.state);
    const target = indexInChain(to);
    if (from < 0 || target !== from + 1) return { ok: false, error: "illegal_transition", from: current.state, to };
    this.appendState(messageId, recipient, to);
    return { ok: true, state: to, changed: true };
  }

  /** Explicit call: read → acked. */
  ack(messageId: string, recipient: string): TransitionResult {
    return this.transition(messageId, recipient, "acked");
  }

  /** Explicit call: acked → done. */
  done(messageId: string, recipient: string): TransitionResult {
    return this.transition(messageId, recipient, "done");
  }

  private normalizeTo(value: unknown): string[] {
    if (typeof value === "string" && value.trim()) return [value.trim()];
    if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
    return [];
  }

  /** True when v3 can deliver to this name itself (identity registry or a live v1-registered agent). */
  resolves(name: string): boolean {
    return !!(this.opts.identity.resolve(name) ?? (this.opts.exists?.(name) ? name : undefined));
  }

  /** `bodyMaxBytes` overrides the v3 280-byte cap; the UBUS_V3 shim passes the v1 limit. */
  send(args: Record<string, unknown>, caller: Caller, limits: { bodyMaxBytes?: number } = {}): ToolResult {
    const sender = caller.handle;
    if (!sender) return { ok: false, error: "not_registered", message: "call ubus_register with {handle, machine}; session is optional" };
    const subject = asString(args.subject);
    const body = asString(args.body);
    const bodyRef = asString(args.body_ref);
    const kind = asString(args.kind, "msg");
    const priority = asString(args.priority, "normal");
    const slaS = asNumber(args.sla_s, 0);
    const to = this.normalizeTo(args.to);
    if (!to.length) return { ok: false, error: "invalid", reason: "invalid", message: "to is required" };
    if (!subject) return { ok: false, error: "invalid", reason: "invalid", message: "subject is required" };
    if (!(KINDS as readonly string[]).includes(kind)) return { ok: false, error: "invalid", reason: "invalid", message: "bad kind" };
    if (!(PRIORITIES as readonly string[]).includes(priority)) return { ok: false, error: "invalid", reason: "invalid", message: "bad priority" };
    if (slaS < 0 || !Number.isFinite(slaS)) return { ok: false, error: "invalid", reason: "invalid", message: "bad sla_s" };
    if (!body && !bodyRef) return { ok: false, error: "invalid", reason: "invalid", message: "body or body_ref is required" };
    if (subject.length > SUBJECT_MAX_CHARS) {
      return { ok: false, error: "too_long", reason: "too_long", field: "subject", limit: SUBJECT_MAX_CHARS, got: subject.length };
    }
    // The body limit holds whether or not a body_ref is attached.
    const bodyMax = limits.bodyMaxBytes ?? BODY_MAX_BYTES;
    if (bytesLen(body) > bodyMax) {
      return { ok: false, error: "too_long", reason: "too_long", field: "body", limit: bodyMax, got: bytesLen(body) };
    }
    if (body && bodyRef) return { ok: false, error: "invalid", reason: "invalid", message: "body and body_ref are mutually exclusive" };
    const checked = checkFilter(`${subject}\n${body}`, this.opts.filter);
    if (!checked.ok) return { ok: false, error: "phi_filter", reason: checked.reason, rule_id: checked.rule_id, spans: checked.spans };
    if (bodyRef) {
      const pathVerdict = checkPath(bodyRef);
      if (!pathVerdict.ok) return { ok: false, error: "phi_filter", reason: pathVerdict.reason, rule_id: pathVerdict.rule_id, spans: pathVerdict.spans };
    }
    for (const artifact of Array.isArray(args.artifacts) ? args.artifacts : []) {
      const path = artifact && typeof artifact === "object" ? asString((artifact as Record<string, unknown>).path) : "";
      if (!path) continue;
      const pathVerdict = checkPath(path);
      if (!pathVerdict.ok) return { ok: false, error: "phi_filter", reason: pathVerdict.reason, rule_id: pathVerdict.rule_id, spans: pathVerdict.spans };
    }
    const accepted: string[] = [];
    const refused: string[] = [];
    for (const name of to) {
      if (addressDenied(name) || isDeniedMachine(name)) return { ok: false, error: "denied_kiosk", message: "kiosk, ICU, and ORB2 targets are denied" };
      const canonical = this.opts.identity.resolve(name) ?? (this.opts.exists?.(name) ? name : undefined);
      if (canonical) accepted.push(canonical);
      else refused.push(name);
    }
    if (!accepted.length) return { ok: false, error: "unknown_agent", reason: "unknown_agent", to: refused.map((name) => this.opts.nameRef(name)) };
    const ts = this.opts.clock.iso();
    const messageId = `v3:${ulid(this.opts.clock.now())}`;
    const threadId = asString(args.thread_id) || `t-${ulid(this.opts.clock.now())}`;
    const allowTerms = checked.allow_terms;
    const meta = {
      from: sender,
      kind,
      priority,
      sla_s: slaS,
      subject,
      body,
      body_ref: bodyRef,
      thread_id: threadId,
      to: accepted,
      allow_terms: allowTerms,
    };
    const delivery: Array<Record<string, unknown>> = [];
    // One transaction: the message row and every per-recipient row land together.
    try {
      this.opts.log.transaction(() => {
        this.commit({ ts, actor: sender, kind: "message.sent", subjectId: messageId, bodyRef: bodyRef || null, meta });
        for (const recipient of accepted) {
          this.appendState(messageId, recipient, "stored");
          delivery.push({ to: recipient, status: "stored" });
        }
        for (const name of refused) {
          // An unknown name is never stored raw: only its HMAC prefix is.
          const ref = this.opts.nameRef(name);
          this.appendState(messageId, ref, "rejected", "unknown_agent");
          delivery.push({ to: ref, status: "rejected", reason: "unknown_agent" });
        }
      });
    } catch (err) {
      this.rebuild();
      throw err;
    }
    return { ok: true, id: messageId, thread_id: threadId, schema: "ubus.msg/3", delivery };
  }

  inbox(args: Record<string, unknown>, caller: Caller): ToolResult {
    const rawHandle = caller.handle;
    if (!rawHandle) return { ok: false, error: "not_registered", message: "call ubus_register with {handle, machine}; session is optional" };
    const handle = this.opts.identity.resolve(rawHandle) ?? rawHandle;
    const limit = clamp(asNumber(args.limit, 10), 1, 100);
    const unreadOnly = asBool(args.unread_only, true);
    const peek = asBool(args.peek, false);
    const threadId = asString(args.thread_id);
    const unread = (state: RecipientState) => state === "stored" || state === "delivered";
    const ids = (this.inboxOf.get(handle) ?? []).filter((mid) => {
      const msg = this.messages.get(mid);
      if (!msg) return false;
      if (threadId && msg.threadId !== threadId) return false;
      const state = this.stateOf(mid, handle)?.state;
      if (unreadOnly && !state) return false;
      if (unreadOnly && state && !unread(state)) return false;
      return true;
    });
    const recent = ids.slice(-limit);
    const messages: Array<Record<string, unknown>> = [];
    for (const mid of recent) {
      const msg = this.messages.get(mid);
      if (!msg) continue;
      const before = this.stateOf(mid, handle)?.state ?? "stored";
      if (!peek) {
        if (before === "stored") this.transition(mid, handle, "delivered");
        this.transition(mid, handle, "read");
      } else if (before === "stored") {
        this.transition(mid, handle, "delivered");
      }
      const state = this.stateOf(mid, handle)?.state ?? before;
      messages.push({
        id: msg.id,
        ts: msg.ts,
        thread_id: msg.threadId,
        reply_to: null,
        from: { handle: msg.from },
        subject: msg.subject,
        body: msgRef(msg),
        kind: msg.kind,
        priority: msg.priority,
        sla_s: msg.slaS,
        state,
        delivery_status: state,
        read: !peek && state !== "stored" && state !== "delivered",
        acked: state === "acked" || state === "done",
      });
    }
    return { ok: true, messages };
  }
}

function msgRef(msg: MsgView): string {
  return msg.body || msg.bodyRef;
}
