import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Caller, ToolResult } from "../bus.js";
import { asString, type Clock } from "../util.js";
import { EventLog } from "./eventlog.js";
import { AllowList, checkFilter, DEFAULT_ALLOWLIST_PATH } from "./filter.js";
import { Identity, SEED_ALIASES, SEED_ID } from "./identity.js";
import { makeNameRef, Messages } from "./messages.js";

/** ubus v3 is off unless UBUS_V3=1. With the flag unset nothing in v3 is opened or consulted. */
export function v3Enabled(): boolean {
  return process.env.UBUS_V3 === "1";
}

/**
 * The HMAC key that turns an unknown name into a ref. Next to the event db by
 * default, or UBUS_V3_NAMEKEY. A missing key file is created with 0600; an
 * existing one is forced back to 0600 before use.
 */
export function nameKeyPath(dbPath: string): string {
  const explicit = process.env.UBUS_V3_NAMEKEY;
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
  return join(dirname(dbPath), "namekey");
}

function loadNameKey(dbPath: string): Buffer {
  const path = nameKeyPath(dbPath);
  let existing: Buffer | undefined;
  try {
    existing = readFileSync(path);
  } catch (err) {
    // Only a missing file may be created; an unreadable key must not be replaced.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (existing) {
    // Replacing a present key would orphan every ref already written with it.
    if (existing.length < 16) throw new Error(`name key ${path} is under 16 bytes; refusing to replace it`);
    chmodSync(path, 0o600);
    return existing;
  }
  const key = randomBytes(32);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key, { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

export interface HubOptions {
  dbPath: string;
  clock: Clock;
  /** Explicit allow-list file; else UBUS_V3_ALLOWLIST; else config/v3-allowlist.json. */
  allowlistPath?: string;
  exists?: (handle: string) => boolean;
}

/**
 * The v3 hub core: an append-only event log with materialized views (agents,
 * messages, per-recipient state, per-recipient inbox) folded from the log.
 * Reopening the same db replays the log and rebuilds identical views.
 */
export class Hub {
  readonly log: EventLog;
  readonly identity: Identity;
  readonly messages: Messages;
  readonly filter: AllowList;

  constructor(opts: HubOptions) {
    this.log = new EventLog(opts.dbPath);
    this.filter = new AllowList(AllowList.resolvePath(opts.allowlistPath), () => this.identity.names());
    this.identity = new Identity(this.log, () => opts.clock.iso());
    this.messages = new Messages({
      log: this.log,
      identity: this.identity,
      filter: this.filter,
      clock: opts.clock,
      nameRef: makeNameRef(loadNameKey(opts.dbPath)),
      exists: opts.exists,
    });
    if (this.log.count() === 0) this.identity.register(SEED_ID, SEED_ALIASES);
    this.replay();
  }

  /** Rebuild every materialized view by folding the log from the first event. */
  replay(): void {
    this.identity.rebuild();
    this.messages.rebuild();
  }

  views(): ReturnType<Identity["snapshot"]> & ReturnType<Messages["snapshot"]> {
    return { ...this.identity.snapshot(), ...this.messages.snapshot() };
  }

  register(id: string, aliases: string[] = []) {
    return this.identity.register(id, aliases);
  }

  send(args: Record<string, unknown>, caller: Caller): ToolResult {
    return this.messages.send(args, caller);
  }

  inbox(args: Record<string, unknown>, caller: Caller): ToolResult {
    return this.messages.inbox(args, caller);
  }

  /**
   * ubus_ack with the flag on (R3-5). Ids v3 does not know come back as
   * `unknown` so the bus can fall through to the v1 store. For ids v3 holds:
   * `read` → acked; a repeat ack is idempotent — no event, state unchanged
   * (acked stays acked, done stays done); `done` is only ever reached through
   * done(). Stored, delivered, rejected or another recipient's row: missing.
   */
  ackTool(args: Record<string, unknown>, caller: Caller): ToolResult {
    const handle = caller.handle;
    if (!handle) return { ok: false, error: "not_registered", message: "call ubus_register with {handle, machine}; session is optional" };
    const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
    if (!ids.length) return { ok: false, error: "invalid", reason: "invalid", message: "ids required" };
    const note = asString(args.note);
    if (note) {
      const verdict = checkFilter(note, this.filter);
      if (!verdict.ok) return { ok: false, error: "phi_filter", reason: verdict.reason, rule_id: verdict.rule_id, spans: verdict.spans };
    }
    const resolved = this.identity.resolve(handle) ?? handle;
    const acked: string[] = [];
    const missing: string[] = [];
    const unknown: string[] = [];
    for (const mid of ids) {
      if (!this.messages.message(mid)) {
        unknown.push(mid);
        continue;
      }
      const state = this.messages.stateOf(mid, resolved)?.state;
      if (state === "read") {
        const step = this.messages.ack(mid, resolved);
        if (step.ok) acked.push(mid);
        else missing.push(mid);
      } else if (state === "acked" || state === "done") {
        acked.push(mid);
      } else {
        missing.push(mid);
      }
    }
    return { ok: true, acked, missing, unknown };
  }

  /** Explicit ack/done for one recipient. Illegal steps are refused. */
  ack(messageId: string, handle: string) {
    const resolved = this.identity.resolve(handle) ?? handle;
    return this.messages.ack(messageId, resolved);
  }

  done(messageId: string, handle: string) {
    const resolved = this.identity.resolve(handle) ?? handle;
    return this.messages.done(messageId, resolved);
  }

  stateOf(messageId: string, handle: string) {
    return this.messages.stateOf(messageId, this.identity.resolve(handle) ?? handle);
  }

  close(): void {
    this.log.close();
  }
}

export function openHub(opts: HubOptions): Hub {
  return new Hub(opts);
}

export { DEFAULT_ALLOWLIST_PATH, SEED_ALIASES, SEED_ID };
export { AllowList, checkFilter, checkPath, locateSpans } from "./filter.js";
export { EventLog } from "./eventlog.js";
export { Identity } from "./identity.js";
export { CHAIN, KINDS, PRIORITIES, Messages, BODY_MAX_BYTES, SUBJECT_MAX_CHARS, makeNameRef } from "./messages.js";
export type { ChainState, MsgView, RecipientState } from "./messages.js";
export type { FilterVerdict } from "./filter.js";
