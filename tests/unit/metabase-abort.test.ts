/** lib/metabase.ts — the optional caller AbortSignal. fetch is mocked; no Metabase is ever called. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { metabaseQuery } from "@/lib/metabase";

const SAVED = { u: process.env.METABASE_URL, k: process.env.METABASE_API_KEY };
beforeEach(() => {
  process.env.METABASE_URL = "https://mb.example.test";
  process.env.METABASE_API_KEY = "test-key-never-printed-0123";
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (SAVED.u === undefined) delete process.env.METABASE_URL; else process.env.METABASE_URL = SAVED.u;
  if (SAVED.k === undefined) delete process.env.METABASE_API_KEY; else process.env.METABASE_API_KEY = SAVED.k;
});

const hangingFetch = (seen: { sig?: AbortSignal }) =>
  vi.fn((_u: string, init: RequestInit) => {
    seen.sig = init.signal as AbortSignal;
    return new Promise<Response>((_res, rej) => {
      if (init.signal!.aborted) return rej(new DOMException("aborted", "AbortError"));
      init.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
    });
  });

describe("metabaseQuery optional signal", () => {
  it("aborting the caller signal aborts the fetch within 100 ms and rejects", async () => {
    const seen: { sig?: AbortSignal } = {};
    vi.stubGlobal("fetch", hangingFetch(seen));
    const ctl = new AbortController();
    const p = metabaseQuery("SELECT 1", { signal: ctl.signal });
    const t0 = Date.now();
    setTimeout(() => ctl.abort(), 10);
    await expect(p).rejects.toThrow(/aborted by caller/);
    expect(Date.now() - t0).toBeLessThan(100);
    expect(seen.sig!.aborted).toBe(true);
  });

  it("an already-aborted signal rejects without waiting", async () => {
    vi.stubGlobal("fetch", hangingFetch({}));
    const ctl = new AbortController();
    ctl.abort();
    await expect(metabaseQuery("SELECT 1", { signal: ctl.signal })).rejects.toThrow(/aborted by caller/);
  });

  it("without a signal the behaviour is unchanged: rows come back keyed by column", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { cols: [{ name: "a" }], rows: [[1]] } }), { status: 200 })));
    expect(await metabaseQuery("SELECT 1")).toEqual([{ a: 1 }]);
  });
});
