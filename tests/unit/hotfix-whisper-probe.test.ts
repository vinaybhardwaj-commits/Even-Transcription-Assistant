/**
 * Hotfix defect 2 — /api/health's whisper probe now tests TRANSCRIPTION.
 *
 * The old probe was `GET /inference`, passing unless the status was >= 500 and not 501. The Mini's
 * shim answers a static 404 to any GET that is not /healthz, without contacting whisper.cpp — so
 * `whisper: true` asserted "the tunnel and a Python process are up" and could not have failed if
 * transcription were completely dead.
 */
import { describe, it, expect, vi } from "vitest";
import {
  probeWhisperTranscription,
  WHISPER_PROBE_BUDGET_MS,
  WHISPER_PROBE_FIXTURE,
} from "@/lib/health/whisper-probe";

const FIXTURE = async () => new Uint8Array([1, 2, 3, 4]);
const res = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

const run = (fetchImpl: (u: string, i: RequestInit) => Promise<Response>, budgetMs?: number) =>
  probeWhisperTranscription({ baseUrl: "https://whisper.example", readFixture: FIXTURE, fetchImpl, ...(budgetMs ? { budgetMs } : {}) });

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
    const out = await probeWhisperTranscription({ baseUrl: null, readFixture: FIXTURE, fetchImpl: async () => res(200, "{}") });
    expect(out).toMatchObject({ ok: false, reason: "not_configured" });
  });

  it("POSTs multipart to /inference — the same shape transcribeWithWhisper uses", async () => {
    let seen: { url?: string; method?: string; isForm?: boolean } = {};
    await run(async (u, i) => {
      seen = { url: u, method: i.method, isForm: i.body instanceof FormData };
      return res(200, "{}");
    });
    expect(seen.url).toBe("https://whisper.example/inference");
    expect(seen.method, "a GET is what could not fail").toBe("POST");
    expect(seen.isForm).toBe(true);
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
