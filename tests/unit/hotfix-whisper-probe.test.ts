/**
 * Hotfix defect 2 — /api/health's whisper probe now tests TRANSCRIPTION.
 *
 * The old probe was `GET /inference`, passing unless the status was >= 500 and not 501. The Mini's
 * shim answers a static 404 to any GET that is not /healthz, without contacting whisper.cpp — so
 * `whisper: true` asserted "the tunnel and a Python process are up" and could not have failed if
 * transcription were completely dead.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  probeWhisperTranscription,
  runWhisperProbe,
  __resetWhisperProbeCache,
  WHISPER_PROBE_BUDGET_MS,
  WHISPER_PROBE_CACHE_MS,
  WHISPER_PROBE_FIXTURE,
  WHISPER_RECENT_OK_MS,
} from "@/lib/health/whisper-probe";

const FIXTURE = async () => new Uint8Array([1, 2, 3, 4]);
const res = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

// These drive the UNCACHED probe: the cache is a separate concern with its own suite below.
const run = (fetchImpl: (u: string, i: RequestInit) => Promise<Response>, budgetMs?: number) =>
  runWhisperProbe({ baseUrl: "https://whisper.example", readFixture: FIXTURE, fetchImpl, ...(budgetMs ? { budgetMs } : {}) });

describe("defect 2 — the probe transcribes, it does not merely ping", () => {
  it("TRUE only on a 200 with a parseable body", async () => {
    const out = await run(async () => res(200, JSON.stringify({ text: "" })));
    expect(out.ok).toBe(true);
    expect(out.status).toBe(200);
    // An EMPTY transcript is a pass: a 0.5 s tone may legitimately decode to nothing, and
    // "did it hear words" is not a question a health route can ask.
    const spoken = await run(async () => res(200, JSON.stringify({ text: "hello" })));
    expect(spoken.ok).toBe(true);
  });

  it("FALSE when the body is unparseable — a 200 alone is not proof", async () => {
    for (const body of ["<html>502 Bad Gateway</html>", "", "not json at all", "null", '"a string"', "[1,2]"]) {
      const out = await run(async () => res(200, body));
      expect(out.ok, `body ${JSON.stringify(body).slice(0, 24)} must not pass`).toBe(false);
      expect(out.reason).toBe("unparseable_body");
      expect(out.status).toBe(200);
    }
  });

  it("FALSE on 404 — which is exactly what the shim answered the OLD probe", async () => {
    const out = await run(async () => res(404, "Not Found"));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("bad_status");
    expect(out.status).toBe(404);
  });

  it("FALSE on any non-200, each named", async () => {
    for (const s of [400, 401, 500, 502, 503]) {
      const out = await run(async () => res(s, "{}"));
      expect(out.ok, String(s)).toBe(false);
      expect(out.reason).toBe("bad_status");
      expect(out.status).toBe(s);
    }
  });

  it("FALSE on timeout, named whisper_timeout, and it does NOT hang", async () => {
    vi.useFakeTimers();
    const p = run((_u, init) => new Promise<Response>((_, rej) => {
      (init.signal as AbortSignal).addEventListener("abort", () => {
        const e = new Error("aborted"); e.name = "AbortError"; rej(e);
      });
    }), 5_000);
    await vi.advanceTimersByTimeAsync(5_001);
    const out = await p;
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("whisper_timeout");
    expect(out.budget_ms).toBe(5_000);
    vi.useRealTimers();
  });

  it("FALSE on a transport error, and never throws", async () => {
    const out = await run(async () => { throw new Error("ECONNREFUSED"); });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("transport");
    expect(String(out.detail)).toContain("ECONNREFUSED");
  });

  it("FALSE, not a throw, when WHISPER_BASE_URL is unset", async () => {
    const out = await runWhisperProbe({ baseUrl: null, readFixture: FIXTURE, fetchImpl: async () => res(200, "{}") });
    expect(out).toMatchObject({ ok: false, reason: "not_configured" });
  });

  it("POSTs multipart to /inference with EXACTLY the fields transcribeWithWhisper sends", async () => {
    let form: FormData | null = null;
    let seen: { url?: string; method?: string } = {};
    await run(async (u, i) => {
      seen = { url: u, method: i.method };
      form = i.body as FormData;
      return res(200, "{}");
    });
    expect(seen.url).toBe("https://whisper.example/inference");
    expect(seen.method, "a GET is what could not fail").toBe("POST");
    // Item 4 — the decoder configuration must be production's, or the probe exercises a path
    // production never takes.
    expect(form!.get("response_format")).toBe("verbose_json");
    expect(form!.get("temperature")).toBe("0.0");
    expect(form!.get("beam_size")).toBe("1");
    expect(form!.get("best_of")).toBe("1");
    // Item 2 — a WEBM, so the shim's ffmpeg transcode leg is exercised. A .wav skipped it, and
    // broken ffmpeg would 415 every real transcription while health reported true.
    const file = form!.get("file") as File;
    expect(file.name).toMatch(/\.webm$/);
    expect(file.type).toBe("audio/webm");
  });

  it("an abort DURING the body read is a timeout, not an unparseable body", async () => {
    // Item 4 — the inner catch used to swallow this and point the operator at the service's
    // output, when the fact is that it never finished sending.
    const out = await run(async (_u, init) => ({
      status: 200,
      async text() {
        const e = new Error("aborted"); e.name = "AbortError";
        (init.signal as AbortSignal).dispatchEvent?.(new Event("abort"));
        throw e;
      },
    } as unknown as Response));
    expect(out.ok).toBe(false);
    expect(out.reason, "an abort mid-body is a timeout").toBe("whisper_timeout");
  });

  it("the budget is well inside the health route's own, and the fixture is committed", async () => {
    expect(WHISPER_PROBE_BUDGET_MS).toBeLessThanOrEqual(15_000);
    const { existsSync, statSync } = await import("node:fs");
    expect(existsSync(WHISPER_PROBE_FIXTURE), "the fixture must be in the repo").toBe(true);
    const st = statSync(WHISPER_PROBE_FIXTURE);
    expect(st.size).toBeGreaterThan(1000);
    // 0.5 s of 16 kHz mono 16-bit is ~16 KB. A 30 s clip would be ~960 KB and ~10 s of VAD.
    expect(st.size).toBeLessThan(64_000);
  });

  it("the health route no longer GETs /inference", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/api/health/route.ts", "utf8");
    expect(src).toMatch(/probeWhisperTranscription\(\)/);
    expect(src).not.toMatch(/\$\{base\}\/inference`,\s*\{\s*method:\s*"GET"/);
  });
});

// ---------------------------------------------------------------------------
// Item 1 — the cache, and the busy rule
// ---------------------------------------------------------------------------

describe("item 1 — at most one real inference a minute, and a busy server is not a broken one", () => {
  const cached = (fetchImpl: (u: string, i: RequestInit) => Promise<Response>, now: () => number, budgetMs?: number) =>
    probeWhisperTranscription({ baseUrl: "https://whisper.example", readFixture: FIXTURE, fetchImpl, now, ...(budgetMs ? { budgetMs } : {}) });

  beforeEach(() => __resetWhisperProbeCache());

  it("runs ONE inference per window and serves the verdict in between, with a growing age", async () => {
    let calls = 0;
    let t = 1_000_000;
    const f = async () => { calls += 1; return res(200, JSON.stringify({ text: "" })); };

    const first = await cached(f, () => t);
    expect(calls).toBe(1);
    expect(first).toMatchObject({ ok: true, cached: false, age_s: 0 });
    expect(typeof first.checked_at).toBe("string");

    t += 30_000;
    const second = await cached(f, () => t);
    expect(calls, "a second call inside the window must not hit the Mini").toBe(1);
    expect(second).toMatchObject({ ok: true, cached: true, age_s: 30 });
    expect(second.checked_at, "the cached answer keeps the ORIGINAL time").toBe(first.checked_at);

    t += WHISPER_PROBE_CACHE_MS;
    const third = await cached(f, () => t);
    expect(calls, "past the window it measures again").toBe(2);
    expect(third).toMatchObject({ cached: false, age_s: 0 });
  });

  it("a timeout with a recent success is BUSY, not broken", async () => {
    let t = 2_000_000;
    const ok = async () => res(200, JSON.stringify({ text: "" }));
    const hang = async (_u: string, init: RequestInit) => new Promise<Response>((_, rej) => {
      (init.signal as AbortSignal).addEventListener("abort", () => { const e = new Error("x"); e.name = "AbortError"; rej(e); });
    });

    expect((await cached(ok, () => t)).ok).toBe(true);   // evidence it transcribes
    t += WHISPER_PROBE_CACHE_MS + 1;                      // past the cache, still inside recent-ok

    vi.useFakeTimers();
    const p = cached(hang, () => t, 5_000);
    await vi.advanceTimersByTimeAsync(5_001);
    const out = await p;
    vi.useRealTimers();

    expect(out.ok, "a serialised inference queue is not a fault").toBe(true);
    expect(out.reason).toBe("busy_recent_ok");
    expect(out.last_ok_age_s).toBeGreaterThanOrEqual(60);
  });

  it("a timeout with NO recent success stays a hard failure", async () => {
    let t = 3_000_000;
    const hang = async (_u: string, init: RequestInit) => new Promise<Response>((_, rej) => {
      (init.signal as AbortSignal).addEventListener("abort", () => { const e = new Error("x"); e.name = "AbortError"; rej(e); });
    });
    vi.useFakeTimers();
    const p = cached(hang, () => t, 5_000);
    await vi.advanceTimersByTimeAsync(5_001);
    const out = await p;
    vi.useRealTimers();
    expect(out).toMatchObject({ ok: false, reason: "whisper_timeout" });
  });

  it("the busy window is finite — an old success does not excuse a timeout for ever", async () => {
    expect(WHISPER_RECENT_OK_MS).toBeGreaterThan(WHISPER_PROBE_CACHE_MS);
    expect(WHISPER_RECENT_OK_MS).toBeLessThanOrEqual(30 * 60_000);
  });

  it("a hard failure is NOT rescued by the busy rule — only a timeout is", async () => {
    let t = 4_000_000;
    const ok = async () => res(200, JSON.stringify({ text: "" }));
    expect((await cached(ok, () => t)).ok).toBe(true);
    t += WHISPER_PROBE_CACHE_MS + 1;
    const out = await cached(async () => res(500, "{}"), () => t);
    expect(out).toMatchObject({ ok: false, reason: "bad_status", status: 500 });
  });
});
