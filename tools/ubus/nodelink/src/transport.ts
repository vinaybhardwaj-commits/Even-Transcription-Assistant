import { createHash, createHmac, randomBytes } from "node:crypto";
import type { NodeEvent } from "./types.js";

export interface SinceResult {
  events: Array<Record<string, unknown> & { id?: string }>;
  next_cursor: string | number | null;
}

export interface PostResult {
  ack_seq: number;
  /** Events the hub refused (rule id only). */
  rejected?: Array<{ seq: number; rule: string }>;
}

export interface Transport {
  postEvents(events: NodeEvent[]): Promise<PostResult>;
  since(cursor: string | null, limit: number): Promise<SinceResult>;
}

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class HttpsTransport implements Transport {
  constructor(
    private readonly hubUrl: string,
    private readonly node: string,
    private readonly key: string,
    private readonly nowMs: () => number,
    private readonly fetchFn: FetchFn = (u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(10_000) }) as never,
  ) {}

  /** A1: HMAC over method, path+query, ts, nonce and sha256(body), for every request. */
  private headers(method: string, url: string, body: string): Record<string, string> {
    const u = new URL(url);
    const ts = new Date(this.nowMs()).toISOString();
    const nonce = randomBytes(16).toString("hex");
    const bodyHash = createHash("sha256").update(body).digest("hex");
    const mac = createHmac("sha256", this.key).update([method, u.pathname + u.search, ts, nonce, bodyHash].join("\n")).digest("hex");
    return { "content-type": "application/json", authorization: `Node ${this.node}:${mac}`, "x-ubus-ts": ts, "x-ubus-nonce": nonce };
  }

  async postEvents(events: NodeEvent[]): Promise<PostResult> {
    const body = JSON.stringify({ events });
    const url = `${this.hubUrl}/api/v3/events`;
    const r = await this.fetchFn(url, { method: "POST", headers: this.headers("POST", url, body), body });
    if (!r.ok) throw new Error(`hub status ${r.status}`);
    const j = (await r.json().catch(() => ({}))) as { ack_seq?: number; rejected?: unknown };
    if (typeof j.ack_seq !== "number") throw new Error("hub reply without ack_seq");
    const rejected: Array<{ seq: number; rule: string }> = [];
    if (Array.isArray(j.rejected)) {
      for (const x of j.rejected as Array<{ seq?: unknown; rule?: unknown }>) {
        if (Number.isSafeInteger(x?.seq)) rejected.push({ seq: x.seq as number, rule: typeof x.rule === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(x.rule) ? x.rule : "rejected" });
      }
    }
    return { ack_seq: j.ack_seq, rejected };
  }

  async since(cursor: string | null, limit: number): Promise<SinceResult> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    const url = `${this.hubUrl}/api/v3/since?${q}`;
    const r = await this.fetchFn(url, { method: "GET", headers: this.headers("GET", url, "") });
    if (!r.ok) throw new Error(`hub status ${r.status}`);
    const j = (await r.json()) as Partial<SinceResult>;
    return { events: j.events ?? [], next_cursor: j.next_cursor ?? null };
  }
}

export class PicoTransport implements Transport {
  postEvents(): Promise<PostResult> {
    throw new Error("not in P1");
  }
  since(): Promise<SinceResult> {
    throw new Error("not in P1");
  }
}
