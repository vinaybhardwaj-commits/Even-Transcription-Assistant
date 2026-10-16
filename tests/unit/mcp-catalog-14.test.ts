/**
 * CATALOG-14 (16 Oct 2026) — loadCatalog never throws away a good cached catalog because of a failed read: stale service for up to 6 h, a 15 s retry backoff, an empty body never replaces
 * a good catalog, one log line per minute with codes and counts only. The lab store is an in-memory double with scripted failures; ids are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ sql: Object.assign(() => Promise.resolve([]), { transaction: async () => [] }), db: {} }));
vi.mock("@/lib/r2", () => ({ getObjectRange: vi.fn(async () => null), headObject: vi.fn(async () => ({ size: null, content_type: null })), signGetUrl: vi.fn(async () => "https://signed.example/x") }));
vi.mock("@/lib/room-access/tool-reads", () => ({ listJevDecisions: vi.fn(async () => ({ rows: [] })) }));
vi.mock("@/lib/rubrics/store", () => ({ listResults: vi.fn(async () => []) }));

import { setLabStoreForTests, ENCOUNTER_CATALOG_KEY, type LabStore } from "@/lib/sarvam-lab";
import { loadCatalog, resetCatalogCacheForTests, CATALOG_CACHE_MS, CATALOG_RETRY_MS, CATALOG_STALE_MAX_MS } from "@/lib/room-access/readers/catalog-consult";
import { catalogTool } from "@/lib/mcp/tools/catalog";
import type { ToolContext } from "@/lib/mcp/registry";
import type { McpScope } from "@/lib/mcp/auth";

type Mode = "ok" | "throw" | "missing";
const S = { mode: "ok" as Mode, body: "", etag: null as string | null, reads: 0 };
const lab: LabStore = {
  async get(key) {
    if (key !== ENCOUNTER_CATALOG_KEY) return null;
    S.reads += 1;
    if (S.mode === "throw") throw new Error("r2 down");
    if (S.mode === "missing") return null;
    return { body: S.body, etag: S.etag };
  },
  async put() { return "ok"; },
  async list() { return []; },
};
const row = (uid: string, o: Record<string, unknown> = {}) => JSON.stringify({ consult_uid: uid, ist_date: "2026-10-05", room_id: "room_a", t_open: 1, t_close: 2, source: "cutter", clip: null, layers: {}, generated_at: "2026-10-14T01:00:00Z", ...o });
const body = (...uids: string[]) => uids.map((u) => row(u)).join("\n") + "\n";
const T0 = 1_760_000_000_000;
const ctx: ToolContext = { actor: "mcp:test", origin: "https://example.test", scopes: new Set<McpScope>(["read"]) };

let logs: string[];
beforeEach(() => {
  S.mode = "ok"; S.body = body("CONS000001", "CONS000002"); S.etag = '"e1"'; S.reads = 0;
  resetCatalogCacheForTests(); setLabStoreForTests(lab);
  logs = [];
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
});
afterEach(() => { setLabStoreForTests(null); vi.restoreAllMocks(); });

const loadGood = async () => { const c = await loadCatalog(T0); expect(c?.rows.size).toBe(2); return c!; };
const STALE_AT = T0 + CATALOG_CACHE_MS + 1; // past the 5 min cache window: a read is attempted

describe("rules 1-2: a failed read serves the cached good catalog and keeps the cache", () => {
  for (const [kind, mode, reason] of [["the read throws", "throw", "read_failed"], ["the object is missing", "missing", "missing"]] as const) {
    it(`${kind}: the cached catalog is returned (the same object), the cache is kept, one stale line {reason:${reason}}`, async () => {
      const good = await loadGood();
      S.mode = mode;
      const got = await loadCatalog(STALE_AT);
      expect(got).toBe(good);
      const line = logs.filter((l) => l.includes("catalog_stale_served"));
      expect(line).toHaveLength(1);
      expect(JSON.parse(line[0]!.replace("[catalog] ", ""))).toEqual({ code: "catalog_stale_served", reason, age_s: Math.round((STALE_AT - T0) / 1000) });
      // recovery: the same etag is a plain refresh, a new etag replaces
      S.mode = "ok";
      expect(await loadCatalog(STALE_AT + CATALOG_RETRY_MS)).toBe(good);
    });
  }

  it("the new body parses to 0 rows: the good cache is kept and served ({reason:empty}); a body of only bad lines counts as empty too", async () => {
    const good = await loadGood();
    S.body = ""; S.etag = '"e2"';
    expect(await loadCatalog(STALE_AT)).toBe(good);
    expect(logs.join("\n")).toContain('"reason":"empty"');
    S.body = "{not json\n[1]\n"; S.etag = '"e3"';
    expect(await loadCatalog(STALE_AT + CATALOG_RETRY_MS)).toBe(good);
  });
});

describe("rule 3: the 6 h stale limit", () => {
  it("served up to and including 6 h after the last successful read; older is null (a long outage is visible)", async () => {
    const good = await loadGood();
    S.mode = "throw";
    expect(await loadCatalog(T0 + CATALOG_STALE_MAX_MS)).toBe(good);
    expect(await loadCatalog(T0 + CATALOG_STALE_MAX_MS + CATALOG_RETRY_MS)).toBeNull(); // 6 h + 15 s
    expect(await loadCatalog(T0 + CATALOG_STALE_MAX_MS + 3_600_000)).toBeNull();
  });

  it("the limit runs from the last SUCCESSFUL read: a refresh with an unchanged etag restarts it", async () => {
    const good = await loadGood();
    await loadCatalog(T0 + CATALOG_CACHE_MS + 1); // same etag: a successful re-read, age restarts
    S.mode = "throw";
    const later = T0 + CATALOG_CACHE_MS + 1 + CATALOG_CACHE_MS + 1;
    expect(await loadCatalog(later)).toBe(good);
    expect(await loadCatalog(T0 + CATALOG_CACHE_MS + 1 + CATALOG_STALE_MAX_MS + 1_000)).toBeNull();
  });
});

describe("rule 4: the 15 s retry", () => {
  it("after a failed read nothing is read for 15 s (stale served), then the next call reads again", async () => {
    const good = await loadGood();
    S.mode = "throw";
    S.reads = 0;
    expect(await loadCatalog(STALE_AT)).toBe(good);
    expect(S.reads).toBe(1);
    expect(await loadCatalog(STALE_AT + 5_000)).toBe(good);
    expect(await loadCatalog(STALE_AT + CATALOG_RETRY_MS - 1)).toBe(good);
    expect(S.reads).toBe(1); // still inside the backoff
    expect(await loadCatalog(STALE_AT + CATALOG_RETRY_MS)).toBe(good);
    expect(S.reads).toBe(2); // retried on the first call at 15 s
    // recovery on the retry replaces the cache with a new etag
    S.mode = "ok"; S.body = body("CONS000001", "CONS000002", "CONS000003"); S.etag = '"e2"';
    const fresh = await loadCatalog(STALE_AT + 2 * CATALOG_RETRY_MS);
    expect(fresh?.rows.size).toBe(3);
    expect(S.reads).toBe(3);
  });

  it("inside the 5 minute window a good cache is served with no read at all, as before", async () => {
    const good = await loadGood();
    S.reads = 0;
    expect(await loadCatalog(T0 + 1_000)).toBe(good);
    expect(S.reads).toBe(0);
  });
});

describe("rule 5: a new catalog with at least 1 row replaces the cache", () => {
  it("a good new body replaces it, the etag logic is unchanged", async () => {
    await loadGood();
    S.body = body("CONS000001", "CONS000002", "CONS000009"); S.etag = '"e2"';
    const fresh = await loadCatalog(STALE_AT);
    expect(fresh?.rows.size).toBe(3);
    expect(fresh?.rows.has("CONS000009")).toBe(true);
    S.mode = "throw";
    expect(await loadCatalog(STALE_AT + CATALOG_CACHE_MS + 1)).toBe(fresh); // the new one is now the good cache
  });

  it("a replacement with 1 row is good (the boundary)", async () => {
    await loadGood();
    S.body = body("CONS000001"); S.etag = '"e2"';
    expect((await loadCatalog(STALE_AT))?.rows.size).toBe(1);
  });
});

describe("rule 6: the first load", () => {
  it("failing with nothing cached is null, every call tries again (no backoff without a cache), and the outage is logged as catalog_unavailable (FIX1), not as a stale serve", async () => {
    S.mode = "throw";
    expect(await loadCatalog(T0)).toBeNull();
    expect(await loadCatalog(T0 + 1)).toBeNull();
    expect(S.reads).toBe(2);
    expect(logs.join("\n")).toContain("catalog_unavailable");
    expect(logs.join("\n")).not.toContain("catalog_stale_served");
    S.mode = "missing";
    expect(await loadCatalog(T0 + 2)).toBeNull();
    S.mode = "ok";
    expect((await loadCatalog(T0 + 3))?.rows.size).toBe(2);
  });

  it("an empty first body is returned as before but is not kept as the good cache (a later good body is read at once)", async () => {
    S.body = ""; S.etag = '"e0"';
    expect((await loadCatalog(T0))?.rows.size).toBe(0);
    S.body = body("CONS000001"); S.etag = '"e1"';
    expect((await loadCatalog(T0 + 1))?.rows.size).toBe(1);
  });
});

describe("the log line", () => {
  it("is at most one per minute, and carries only code, reason and age_s: no key, no text, no id", async () => {
    await loadGood();
    S.mode = "throw";
    await loadCatalog(STALE_AT);
    await loadCatalog(STALE_AT + CATALOG_RETRY_MS);      // fails again, inside the minute
    await loadCatalog(STALE_AT + 2 * CATALOG_RETRY_MS);
    expect(logs.filter((l) => l.includes("catalog_stale_served"))).toHaveLength(1);
    await loadCatalog(STALE_AT + 60_000);                // a minute after the first line
    const lines = logs.filter((l) => l.includes("catalog_stale_served"));
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      const o = JSON.parse(l.replace("[catalog] ", "")) as Record<string, unknown>;
      expect(Object.keys(o).sort()).toEqual(["age_s", "code", "reason"]);
      expect(typeof o.age_s).toBe("number");
    }
    const all = logs.join("\n");
    expect(all).not.toMatch(/CONS0000|palimpsest|encounter-catalog|consult-clips|room_a/);
  });
});

describe("FIX1: a long outage is visible in the logs", () => {
  const unavailLines = () => logs.filter((l) => l.includes("catalog_unavailable")).map((l) => JSON.parse(l.replace("[catalog] ", "")) as Record<string, unknown>);

  it("past the 6 h stale limit a failed read logs {code:catalog_unavailable, reason, age_s}, at most once per 60 s, with no key or text", async () => {
    await loadGood();
    S.mode = "throw";
    const t = T0 + CATALOG_STALE_MAX_MS + 1_000;
    expect(await loadCatalog(t)).toBeNull();
    expect(await loadCatalog(t + CATALOG_RETRY_MS)).toBeNull();       // another failed read inside the minute
    expect(await loadCatalog(t + 2 * CATALOG_RETRY_MS)).toBeNull();
    expect(unavailLines()).toEqual([{ code: "catalog_unavailable", reason: "read_failed", age_s: Math.round((t - T0) / 1000) }]);
    expect(await loadCatalog(t + 60_000)).toBeNull();                 // a minute after the first line: one more
    expect(unavailLines()).toHaveLength(2);
    expect(unavailLines()[1]).toEqual({ code: "catalog_unavailable", reason: "read_failed", age_s: Math.round((t + 60_000 - T0) / 1000) });
    expect(logs.filter((l) => l.includes("catalog_stale_served"))).toHaveLength(0); // nothing was served stale
    const all = logs.join("\n");
    for (const l of unavailLines()) expect(Object.keys(l).sort()).toEqual(["age_s", "code", "reason"]);
    expect(all).not.toMatch(/CONS0000|palimpsest|encounter-catalog|consult-clips|room_a/);
  });

  it("the reason follows the failure kind past the limit (missing); a stale serve inside the limit does not log catalog_unavailable", async () => {
    await loadGood();
    S.mode = "missing";
    await loadCatalog(T0 + CATALOG_STALE_MAX_MS - 1_000);             // still within the limit: served stale
    expect(unavailLines()).toHaveLength(0);
    await loadCatalog(T0 + CATALOG_STALE_MAX_MS + 100_000);           // past it
    expect(unavailLines()).toEqual([{ code: "catalog_unavailable", reason: "missing", age_s: Math.round((CATALOG_STALE_MAX_MS + 100_000) / 1000) }]);
  });

  it("past the limit inside the 15 s backoff (no read made) it still logs, rate-limited, with the reason of the failed read", async () => {
    await loadGood();
    S.mode = "throw";
    await loadCatalog(T0 + CATALOG_STALE_MAX_MS);                      // fails at exactly 6 h: served stale, backoff starts
    const t = T0 + CATALOG_STALE_MAX_MS + 5_000;                       // inside the backoff, now past the limit
    S.reads = 0;
    expect(await loadCatalog(t)).toBeNull();
    expect(S.reads).toBe(0);
    expect(unavailLines()).toEqual([{ code: "catalog_unavailable", reason: "read_failed", age_s: Math.round((t - T0) / 1000) }]);
  });

  it("nothing cached: the first-load failure logs catalog_unavailable with age_s null, once per minute", async () => {
    S.mode = "missing";
    await loadCatalog(T0);
    await loadCatalog(T0 + 1_000);
    expect(unavailLines()).toEqual([{ code: "catalog_unavailable", reason: "missing", age_s: null }]);
    await loadCatalog(T0 + 60_000);
    expect(unavailLines()).toHaveLength(2);
  });
});

describe("rule 8: scribe_catalog answers do not change shape", () => {
  it("during a read failure the tool answers from the stale catalog (not catalog_unavailable); past 6 h it answers catalog_unavailable as today", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(T0));
      S.body = body("CONS000001") ; S.etag = '"e1"';
      const url = await catalogTool.handler({ action: "clip_audio_url", consult_uid: "CONS000001" }, ctx);
      expect(url).toMatchObject({ ok: false, error: "no_clip" });
      S.mode = "throw";
      vi.setSystemTime(new Date(STALE_AT));
      expect(await catalogTool.handler({ action: "clip_audio_url", consult_uid: "CONS000001" }, ctx)).toMatchObject({ ok: false, error: "no_clip" });
      vi.setSystemTime(new Date(T0 + CATALOG_STALE_MAX_MS + 60_000));
      expect(await catalogTool.handler({ action: "clip_audio_url", consult_uid: "CONS000001" }, ctx)).toEqual({ ok: false, error: "catalog_unavailable" });
    } finally {
      vi.useRealTimers();
    }
  });
});
