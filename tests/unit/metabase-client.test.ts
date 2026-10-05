/** lib/metabase.ts — the uid-list escaper and the shape of the one request it makes. fetch is mocked; no Metabase is ever called. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isSafeUid, metabaseQuery, uidListLiteral, WAREHOUSE_DB_ID, METABASE_TIMEOUT_MS } from "@/lib/metabase";

const KEY = "test-key-never-printed-0123";
const URL_ = "https://mb.example.test///";
const SAVED = { u: process.env.METABASE_URL, k: process.env.METABASE_API_KEY };

beforeEach(() => {
  process.env.METABASE_URL = URL_;
  process.env.METABASE_API_KEY = KEY;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (SAVED.u === undefined) delete process.env.METABASE_URL; else process.env.METABASE_URL = SAVED.u;
  if (SAVED.k === undefined) delete process.env.METABASE_API_KEY; else process.env.METABASE_API_KEY = SAVED.k;
});

describe("uidListLiteral — the only way a value reaches the Metabase SQL text", () => {
  it("quotes, de-duplicates and keeps first-seen order", () => {
    expect(uidListLiteral(["abc123", "x_y-z", "abc123"])).toBe("'abc123','x_y-z'");
  });

  it("THROWS on anything outside [A-Za-z0-9_-]: quote, space, semicolon, comment, newline, unicode, empty, too long", () => {
    for (const bad of ["a'b", "a b", "a;b", "a\nb", "a\"b", "a)b", "é", "", "a/b", "a.b", "x".repeat(129), "' OR 1=1 --"]) {
      expect(() => uidListLiteral(["fine", bad]), JSON.stringify(bad)).toThrow(/unsafe uid/);
    }
  });

  it("throws on an empty list and on a non-string", () => {
    expect(() => uidListLiteral([])).toThrow(/empty/);
    expect(() => uidListLiteral([null as unknown as string])).toThrow(/unsafe/);
    expect(() => uidListLiteral([42 as unknown as string])).toThrow(/unsafe/);
  });

  it("isSafeUid agrees", () => {
    expect(isSafeUid("uprUJbQnetwvlFrmm2tb")).toBe(true);
    expect(isSafeUid("a'b")).toBe(false);
    expect(isSafeUid(null)).toBe(false);
    expect(isSafeUid(undefined)).toBe(false);
    expect(isSafeUid("")).toBe(false);
  });
});

const okResponse = (body: unknown, init: { status?: number } = {}) =>
  ({ ok: (init.status ?? 200) < 400, status: init.status ?? 200, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) }) as unknown as Response;

describe("metabaseQuery — request shape", () => {
  it("POSTs a native query for database 13 to <base>/api/dataset with the x-api-key header and an abort signal", async () => {
    const f = vi.fn().mockResolvedValue(okResponse({ data: { cols: [{ name: "consult_uid" }, { name: "doctor_uid" }], rows: [["c1", "d1"], ["c2", null]] } }));
    vi.stubGlobal("fetch", f);
    const rows = await metabaseQuery("SELECT 1");
    expect(rows).toEqual([{ consult_uid: "c1", doctor_uid: "d1" }, { consult_uid: "c2", doctor_uid: null }]);
    expect(WAREHOUSE_DB_ID).toBe(13);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://mb.example.test/api/dataset"); // trailing slashes trimmed
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json", "x-api-key": KEY });
    expect(JSON.parse(init.body as string)).toEqual({ database: 13, type: "native", native: { query: "SELECT 1" } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns [] for a result with no rows", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse({ data: { cols: [{ name: "a" }], rows: [] } })));
    expect(await metabaseQuery("SELECT 1")).toEqual([]);
  });

  it("an HTTP error carries the status and a short body, never the key or the URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse("nope".repeat(200), { status: 403 })));
    const e = await metabaseQuery("SELECT 1").catch((x: Error) => x);
    expect((e as Error).message).toMatch(/^Metabase HTTP 403: /);
    expect((e as Error).message.length).toBeLessThan(260);
    expect((e as Error).message).not.toContain(KEY);
    expect((e as Error).message).not.toContain("mb.example.test");
  });

  it("a failed query, a non-JSON body and a network error each throw a generic message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse({ status: "failed", error: "syntax error near x" })));
    await expect(metabaseQuery("SELECT 1")).rejects.toThrow(/query failed: syntax error/);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse("<html>")));
    await expect(metabaseQuery("SELECT 1")).rejects.toThrow(/non-JSON/);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(`connect ECONNREFUSED https://mb.example.test ${KEY}`)));
    const e = await metabaseQuery("SELECT 1").catch((x: Error) => x);
    expect((e as Error).message).toMatch(/request failed/);
    expect((e as Error).message).not.toContain(KEY);
  });

  it("throws, naming only the variable, when METABASE_URL or METABASE_API_KEY is unset, and never calls fetch", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    delete process.env.METABASE_URL;
    await expect(metabaseQuery("SELECT 1")).rejects.toThrow("METABASE_URL is not set");
    process.env.METABASE_URL = URL_;
    delete process.env.METABASE_API_KEY;
    await expect(metabaseQuery("SELECT 1")).rejects.toThrow("METABASE_API_KEY is not set");
    expect(f).not.toHaveBeenCalled();
  });

  it(`aborts after ${METABASE_TIMEOUT_MS} ms`, async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_u: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })));
    const p = metabaseQuery("SELECT 1").catch((x: Error) => x);
    await vi.advanceTimersByTimeAsync(METABASE_TIMEOUT_MS - 1);
    let settled = false;
    void p.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(((await p) as Error).message).toBe(`Metabase: timed out after ${METABASE_TIMEOUT_MS} ms`);
  });
});
