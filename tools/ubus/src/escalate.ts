import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HerdrAdapter } from "./adapters.js";
import type { UbusConfig } from "./config.js";
import { NUDGE_GAP_MS, HOUR_MS } from "./constants.js";
import type { AgentRow, Store } from "./store.js";
import type { Clock } from "./util.js";

const ENABLED_AT_KEY = "escalation_enabled_at";
export const STEWARD = "ubus-steward";
/** Only deliveries this young are watched, so the first sweep after a deploy does not chase old history. */
export const WATCH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const ESCALATION_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const DIGEST_TOP = 10;

export interface EscalatorDeps {
  config: UbusConfig;
  store: Store;
  herdr: HerdrAdapter;
  clock: Clock;
  presenceOf: (agent: AgentRow) => string;
  isSystem: (agent: AgentRow) => boolean;
  /** Sends one ubus message from the steward row. Ids only. */
  send: (to: string, subject: string, body: string, scope?: "internal" | "all") => { id?: string; reason?: string };
  /** True when the handle is outside the trust boundary (grok, cloudflare): never quote subjects to it. */
  isExternal?: (handle: string) => boolean;
}

interface Watched {
  deliveryId: number;
  messageId: string;
  recipient: string;
  createdMs: number;
  subject: string;
  /** Created before escalation was switched on. Counted in the digest, never chased. */
  pre: boolean;
}

/**
 * Plain server code, no LLM. Watches actionable deliveries nobody has acked:
 * wake the recipient, then tell its orchestrator, then put it in the daily digest.
 * State lives in the escalations table, so a restart does not wake twice.
 */
export class Escalator {
  constructor(private d: EscalatorDeps) {
    this.watchStart();
  }

  /**
   * escalation_enabled_at: set on the first start with escalation enabled, kept across restarts,
   * cleared when escalation is switched off so the next enable starts a fresh watch.
   */
  private watchStart(): number {
    if (!this.cfg.enabled) {
      if (this.d.store.getState(ENABLED_AT_KEY)) this.d.store.clearState(ENABLED_AT_KEY);
      return Infinity;
    }
    let at = this.d.store.getState(ENABLED_AT_KEY);
    if (!at) {
      at = this.d.clock.iso();
      this.d.store.setState(ENABLED_AT_KEY, at);
    }
    return Date.parse(at);
  }

  enabledAt(): string {
    return this.d.store.getState(ENABLED_AT_KEY);
  }

  private get cfg() {
    return this.d.config.escalation;
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  sweep(): void {
    this.watchStart();
    if (!this.cfg.enabled) return;
    const now = this.d.clock.now();
    this.stage(now);
    this.digest(now);
    this.d.store.pruneEscalations(new Date(now - ESCALATION_KEEP_MS).toISOString());
  }

  /** Counts for /health. */
  status(): { enabled: boolean; last_hour: Record<string, number> } {
    const since = new Date(this.d.clock.now() - HOUR_MS).toISOString();
    const c = this.d.store.escalationCounts(since);
    return { enabled: this.cfg.enabled, last_hour: { wake: c.wake ?? 0, escalate: c.escalate ?? 0, digest: c.digest ?? 0 } };
  }

  /** Unacked, actionable, young enough, recipient not exempt. Grouped by recipient, oldest first. */
  private watched(now: number, onlyReachable: boolean): Map<string, Watched[]> {
    const since = new Date(now - WATCH_MAX_AGE_MS).toISOString();
    const start = this.watchStart();
    const out = new Map<string, Watched[]>();
    const agents = new Map<string, AgentRow | undefined>();
    for (const r of this.d.store.unackedDeliveries(since)) {
      const to = r.toHandle;
      if (to.startsWith("grok:") || this.cfg.exemptHandles.includes(to)) continue;
      if (r.fromHandle === STEWARD || r.fromHandle === "ubus") continue;
      const request = r.kind === "request" && r.reqState !== "";
      const actionable = request ? r.reqState === "pending" : r.wake === 1 && r.priority !== "low";
      if (!actionable) continue;
      if (!agents.has(to)) agents.set(to, this.d.store.getAgent(to));
      const agent = agents.get(to);
      if (!agent || agent.closed || this.d.isSystem(agent) || agent.runtime === "grok") continue;
      if (onlyReachable) {
        const presence = this.d.presenceOf(agent);
        if (presence !== "live" && presence !== "stale") continue;
      }
      const list = out.get(to) ?? [];
      list.push({ deliveryId: r.id, messageId: r.messageId, recipient: to, createdMs: Date.parse(r.createdAt), subject: r.subject, pre: Date.parse(r.createdAt) < start });
      out.set(to, list);
    }
    return out;
  }

  private stage(now: number): void {
    const at = new Date(now).toISOString();
    const wakeMs = this.cfg.wakeAfterS * 1000;
    const escMs = this.cfg.escalateAfterS * 1000;
    const since = new Date(now - WATCH_MAX_AGE_MS).toISOString();
    const escalated = this.d.store.escalatedDeliveryIds("escalate", since);
    for (const [recipient, items] of this.watched(now, true)) {
      const open = items.filter((w) => !w.pre && !escalated.has(w.deliveryId));
      const toEscalate = open.filter((w) => now - w.createdMs >= escMs);
      const toWake = open.filter((w) => now - w.createdMs >= wakeMs && now - w.createdMs < escMs);
      if (toWake.length) {
        const last = this.d.store.lastEscalationAt(recipient, "wake");
        if (!last || now - Date.parse(last) >= wakeMs) {
          const outcome = this.wake(recipient, now);
          this.d.store.insertEscalation({ deliveryId: toWake[0]!.deliveryId, recipient, stage: "wake", at, outcome });
        }
      }
      if (toEscalate.length) {
        const last = this.d.store.lastEscalationAt(recipient, "escalate");
        if (!last || now - Date.parse(last) >= escMs) this.escalate(recipient, toEscalate, now, at);
      }
    }
  }

  /** Content-free nudge through the same herdr adapter the send path uses. */
  private wake(handle: string, now: number): string {
    const pane = this.d.herdr.listAgents().find((a) => a.name === handle);
    if (!pane) return "no_pane";
    if (pane.busy || (pane.state !== "idle" && pane.state !== "done")) return "busy";
    const lastNudge = this.d.store.lastNudge(handle);
    if (lastNudge && now - Date.parse(lastNudge) < NUDGE_GAP_MS) return "recent_nudge";
    this.d.herdr.nudge(handle, pane.machine);
    this.d.store.setNudge(handle, new Date(now).toISOString());
    return "nudged";
  }

  private escalate(recipient: string, items: Watched[], now: number, at: string): void {
    const agent = this.d.store.getAgent(recipient);
    let target = (agent?.orchestrator && agent.orchestrator !== recipient && agent.orchestrator) || (agent?.owner && agent.owner !== recipient && agent.owner) || "gating-lead";
    if (target === recipient) target = "gating-lead";
    const ages = items.map((w) => Math.round((now - w.createdMs) / 60_000));
    const subject = `[ubus] unacked for ${recipient}`.slice(0, 120);
    // An external target gets ids only. Otherwise subjects are quoted, and the message is scoped internal when any quoted source was.
    const external = this.d.isExternal ? this.d.isExternal(target) : true;
    const lines = items.slice(0, 20).map((w, i) => (external ? `${w.messageId} age ${ages[i]}m` : `${w.messageId} age ${ages[i]}m "${w.subject.slice(0, 60)}"`));
    const scope: "internal" | "all" = !external && items.slice(0, 20).some((w) => this.internalScope(w.messageId)) ? "internal" : "all";
    const more = items.length > 20 ? `\n+${items.length - 20} more` : "";
    const body = `${recipient} has ${items.length} unacked actionable message(s), oldest ${Math.max(...ages)}m.\n${lines.join("\n")}${more}`;
    let outcome: string;
    try {
      const res = this.d.send(target, subject, body, scope);
      if (res.id && this.d.store.getMessage(res.id)) {
        outcome = `sent:${target}`;
        if (this.wake(target, now) === "nudged") outcome += "+nudged";
      } else outcome = `not_sent:${res.reason || "no_message_row"}`;
    } catch (err) {
      outcome = `not_sent:error:${err instanceof Error ? err.message.slice(0, 40) : "unknown"}`;
    }
    for (const w of items) this.d.store.insertEscalation({ deliveryId: w.deliveryId, recipient, stage: "escalate", at, outcome });
  }

  private internalScope(messageId: string): boolean {
    try {
      const m = this.d.store.getMessage(messageId);
      return (JSON.parse(m?.phiJson || "{}") as Record<string, unknown>).scope === "internal";
    } catch {
      return false;
    }
  }

  private digest(now: number): void {
    const [hh, mm] = this.cfg.digestAt.split(":").map(Number) as [number, number];
    const today = new Date(now);
    const due = new Date(today.getFullYear(), today.getMonth(), today.getDate(), hh, mm, 0, 0).getTime();
    if (now < due) return;
    const last = this.d.store.lastEscalationAt("*", "digest");
    if (last && Date.parse(last) >= due) return;
    const at = new Date(now).toISOString();
    const dayAgo = new Date(now - 24 * HOUR_MS).toISOString();
    const rows = [...this.watched(now, false)].map(([recipient, all]) => {
      const items = all.filter((w) => !w.pre);
      const before = all.filter((w) => w.pre);
      return {
        recipient,
        count: items.length,
        before: before.length,
        oldestMin: Math.round((now - Math.min(...all.map((w) => w.createdMs))) / 60_000),
        escalations: this.d.store.escalationCount("escalate", recipient, dayAgo),
        ids: items.map((w) => w.messageId),
        beforeIds: before.map((w) => w.messageId),
      };
    });
    rows.sort((a, b) => b.count - a.count || b.oldestMin - a.oldestMin);
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const lines = [
      `# Unacked actionable messages, ${date}`,
      "",
      `Recipients: ${rows.length}. Total unacked actionable: ${rows.reduce((n, r) => n + r.count, 0)}. Before watch start (counted, never escalated): ${rows.reduce((n, r) => n + r.before, 0)}.`,
      "",
      "| recipient | unacked | before watch start | oldest (min) | escalations sent (24h) |",
      "|---|---|---|---|---|",
      ...rows.map((r) => `| ${r.recipient} | ${r.count} | ${r.before} | ${r.oldestMin} | ${r.escalations} |`),
      "",
      ...rows.flatMap((r) => [`## ${r.recipient}`, r.ids.join(", "), ...(r.before ? [`Before watch start: ${r.beforeIds.join(", ")}`] : []), ""]),
    ];
    let path = "";
    try {
      mkdirSync(this.cfg.digestDir, { recursive: true, mode: 0o700 });
      path = join(this.cfg.digestDir, `UNACKED-${date}.md`);
      writeFileSync(path, lines.join("\n"), { mode: 0o600 });
    } catch {
      path = "";
    }
    const top = rows.slice(0, DIGEST_TOP).map((r) => `${r.recipient} ${r.count} (+${r.before} before watch start; oldest ${r.oldestMin}m, esc ${r.escalations})`);
    const body = `Unacked digest ${date}: ${rows.length} recipient(s).\n${path ? `File: ${path}` : "File: not written"}\n${top.join("\n") || "none"}`;
    let notSent = 0;
    for (const to of this.cfg.digestTo) {
      try {
        const res = this.d.send(to, `[ubus] unacked digest ${date}`, body);
        if (!res.id || !this.d.store.getMessage(res.id)) notSent += 1;
      } catch {
        notSent += 1;
      }
    }
    const written = path ? "written" : "write_failed";
    this.d.store.insertEscalation({ deliveryId: 0, recipient: "*", stage: "digest", at, outcome: notSent ? `${written};not_sent:${notSent}` : written });
  }
}
