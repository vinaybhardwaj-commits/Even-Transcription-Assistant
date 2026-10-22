// Part E: the Buddy shadow feed. sql, fetch and the presigner are mocked; no network, no database.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Ref = { opaque_id: string; room_id: string; opened_at: string; closed_at: string | null; live: boolean; window: boolean };
const state = vi.hoisted(() => ({ refs: [] as Ref[], calls: [] as Array<{ text: string; values: unknown[] }> }));

// A tagged-template fake that applies the query's own parameters to the fixture rows (room, ended, started, grace minutes).
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    state.calls.push({ text: strings.join("?"), values });
    const [room, ended, started, grace, started2, openMax] = values as [string, string, string, number, string, number];
    const rows = state.refs
      .filter((r) => r.room_id === room && r.live && !r.window)
      .filter((r) => Date.parse(r.opened_at) <= Date.parse(ended))
      .filter((r) => r.closed_at === null || Date.parse(r.closed_at) >= Date.parse(started) - grace * 60_000)
      .filter((r) => Date.parse(r.opened_at) >= Date.parse(started2) - openMax * 60_000)
      .map((r) => ({ opaque_id: r.opaque_id }));
    return Promise.resolve(rows.slice(0, 1));
  },
}));
vi.mock("@/lib/r2", () => ({ signGetUrl: vi.fn(async () => "https://r2.example/sig") }));

import { buddyFeed, feedCounters, PRESIGN_MAX_S } from "@/lib/buddy/feed";

const OPAQUE = "0123456789abcdef0123456789abcdef";
const START = new Date("2026-10-21T10:00:00.000Z");
const END = new Date("2026-10-21T10:05:00.000Z");
const piece = (roomId = "room-a") => ({ roomId, idx: 7, r2Key: "bench/some/key.webm", startedAt: START, endedAt: END });
const env = { BUDDY_FEED: "on", BUDDY_FEED_URL: "https://newcat.example/internal/feed", NEWCAT_RELAY_KEY: "secret-relay-key", BUDDY_RELAY_ROOMS: "room-a,room-b" } as unknown as NodeJS.ProcessEnv;
const min = (m: number) => new Date(START.getTime() + m * 60_000).toISOString();
const ref = (over: Partial<Ref> = {}): Ref => ({ opaque_id: OPAQUE, room_id: "room-a", opened_at: min(-30), closed_at: null, live: true, window: false, ...over });

let fetchFn: ReturnType<typeof vi.fn>;
let presign: ReturnType<typeof vi.fn>;
const sleep = vi.fn(async () => {});
const run = (p = piece(), e = env) => buddyFeed(p, { env: e, fetchFn: fetchFn as unknown as typeof fetch, presign, sleep });
let logs: string[];

beforeEach(() => {
  state.refs = [];
  state.calls = [];
  for (const k of Object.keys(feedCounters)) feedCounters[k] = 0;
  fetchFn = vi.fn(async () => ({ ok: true }));
  presign = vi.fn(async () => ["https://r2.example/sig", "?X-Amz-", "Signature=abc"].join(""));
  logs = [];
  for (const m of ["log", "warn", "error", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
});
afterEach(() => vi.restoreAllMocks());

describe("buddyFeed", () => {
  it("flag off: no query, no post", async () => {
    state.refs = [ref()];
    for (const v of [undefined, "", "ON", "true", "1"]) {
      expect(await run(piece(), { ...env, BUDDY_FEED: v } as NodeJS.ProcessEnv)).toBe("off");
    }
    expect(state.calls).toHaveLength(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("BUDDY_FEED_URL unset: no post", async () => {
    state.refs = [ref()];
    await run(piece(), { ...env, BUDDY_FEED_URL: undefined } as NodeJS.ProcessEnv);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(state.calls).toHaveLength(0);
  });

  it("a room not in BUDDY_RELAY_ROOMS: no post, no query", async () => {
    state.refs = [ref({ room_id: "room-z" })];
    expect(await run(piece("room-z"))).toBe("room");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(state.calls).toHaveLength(0);
  });

  it("no overlapping shadow ref: no post", async () => {
    state.refs = [ref({ opened_at: min(20) })];
    expect(await run()).toBe("no_shadow_consult");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(feedCounters.buddy_feed_skipped_no_shadow_consult).toBe(1);
  });

  it("open ref: exactly 1 post, exact body keys, Authorization present, one parameterised query", async () => {
    state.refs = [ref()];
    expect(await run()).toBe("posted");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(env.BUDDY_FEED_URL);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-relay-key");
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body).sort()).toEqual(["ended_at", "opaque_id", "piece_idx", "started_at", "url"]);
    expect(body).toMatchObject({ opaque_id: OPAQUE, piece_idx: 7, started_at: START.toISOString(), ended_at: END.toISOString() });
    expect(state.calls).toHaveLength(1);
    expect(feedCounters.buddy_feed_posted).toBe(1);
  });

  it("ref closed 9 min before: post; 11 min before: no post", async () => {
    state.refs = [ref({ closed_at: min(-9) })];
    expect(await run()).toBe("posted");
    state.refs = [ref({ closed_at: min(-11) })];
    expect(await run()).toBe("no_shadow_consult");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("refute S1: an open ref older than 90 min (lost close) stops feeding", async () => {
    state.refs = [ref({ opened_at: min(-89) })];
    expect(await run()).toBe("posted");
    state.refs = [ref({ opened_at: min(-91) })];
    expect(await run()).toBe("no_shadow_consult");
    state.refs = [ref({ opened_at: min(-360), closed_at: null })];
    expect(await run()).toBe("no_shadow_consult");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("a window (non-shadow) ref: no post", async () => {
    state.refs = [ref({ window: true, live: true }), ref({ window: true, live: false, opaque_id: "b".repeat(32) })];
    expect(await run()).toBe("no_shadow_consult");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("the query reads the stored decision and the grace from parameters", () => {
    // the SQL text itself is the contract with the fake above
    return run().then(() => {
      state.refs = [ref()];
    }).then(async () => {
      await run();
      const t = state.calls[0]!.text;
      expect(t).toContain("c.args->>'live' = 'true'");
      expect(t).toContain("c.args->>'window' = 'false'");
      expect(t).toContain("make_interval(mins =>");
    });
  });

  it("fetch rejects twice: never throws, failed counted, one retry after the delay", async () => {
    state.refs = [ref()];
    fetchFn = vi.fn(async () => { throw new Error("boom https://r2.example/sig"); });
    expect(await run()).toBe("failed");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(feedCounters.buddy_feed_failed).toBe(1);
  });

  it("a query fault never throws", async () => {
    state.refs = [ref()];
    const r = await buddyFeed(piece(), { env, fetchFn: fetchFn as unknown as typeof fetch, query: async () => { throw new Error("db"); }, presign, sleep });
    expect(r).toBe("failed");
  });

  it("presign expiry is at most 900 s and targets the chunk object", async () => {
    state.refs = [ref()];
    await run();
    expect(presign).toHaveBeenCalledWith("bench/some/key.webm", expect.any(Number));
    expect(presign.mock.calls[0]![1]).toBeLessThanOrEqual(900);
    expect(PRESIGN_MAX_S).toBeLessThanOrEqual(900);
  });

  it("no URL, opaque_id, key or R2 key in any console output", async () => {
    state.refs = [ref()];
    await run();
    fetchFn = vi.fn(async () => { throw new Error("x"); });
    await run();
    const all = logs.join("\n");
    for (const s of [OPAQUE, "secret-relay-key", "r2.example", "X-Amz", "newcat.example", "bench/some/key"]) expect(all).not.toContain(s);
    expect(logs.length).toBeGreaterThan(0);
  });
});
