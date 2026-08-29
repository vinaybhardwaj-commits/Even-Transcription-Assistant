/**
 * Build 1 §C.2 / §C.3 — one retry with backoff, the latency that was never recorded, and the
 * named failure state when both attempts fail.
 *
 * Grounding §A5: "No retry inside the client. A single transient tunnel blip burns one of three
 * job attempts." And: "Whisper's latency is not recorded anywhere on the room path."
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  transcribeWithWhisper,
  isRetryableWhisperError,
  WHISPER_RETRY_BACKOFF_MS,
} from "@/lib/whisper";

const OK_BODY = { text: "hello", language: "english", duration: 1.2, segments: [] };

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("which failures earn a second attempt", () => {
  it("a transport blip does — that is the whole point", () => {
    expect(isRetryableWhisperError("network: fetch failed")).toBe(true);
    expect(isRetryableWhisperError("http_502: bad gateway")).toBe(true);
    expect(isRetryableWhisperError("http_500: boom")).toBe(true);
    expect(isRetryableWhisperError("http_503")).toBe(true);
  });

  it("a TIMEOUT does not — retrying 180s would blow the 300s function budget", () => {
    expect(isRetryableWhisperError("timeout_180000ms")).toBe(false);
    expect(isRetryableWhisperError("timeout_90000ms")).toBe(false);
  });

  it("a 4xx does not — the server understood and refused", () => {
    expect(isRetryableWhisperError("http_400: bad request")).toBe(false);
    expect(isRetryableWhisperError("http_404")).toBe(false);
  });

  it("empty_transcript does NOT — a quiet window's true answer is not a fault to retry away", () => {
    expect(isRetryableWhisperError("empty_transcript")).toBe(false);
  });

  it("missing configuration does not — it will be missing again in two seconds", () => {
    expect(isRetryableWhisperError("whisper_base_url_missing")).toBe(false);
  });
});

describe("the retry, end to end", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.WHISPER_BASE_URL = "https://whisper.example.test";
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  /** Drive the fake clock while the call is in flight so the 2 s backoff does not stall the test. */
  async function withClock<T>(p: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(WHISPER_RETRY_BACKOFF_MS + 100);
    return p;
  }

  it("a blip then a success returns the transcript, and says it took two attempts", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(jsonResponse(OK_BODY));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const r = await withClock(transcribeWithWhisper(Buffer.from("x"), "audio/webm"));
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.attempts).toBe(2);
    if (r.ok) {
      expect(r.transcript).toBe("hello");
      // The blip is not lost — a link that flaps is a fact worth keeping.
      expect(r.first_error).toContain("network:");
    }
  });

  it("BOTH attempts failing is reported, not swallowed — no silent skip", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("socket hang up"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const r = await withClock(transcribeWithWhisper(Buffer.from("x"), "audio/webm"));
    expect(r.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.attempts).toBe(2);
    if (!r.ok) expect(r.error).toContain("network:");
  });

  it("there is no THIRD attempt — the drain owns the ladder above this one", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("down"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await withClock(transcribeWithWhisper(Buffer.from("x"), "audio/webm"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a first-attempt success never costs a second call", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(OK_BODY));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await transcribeWithWhisper(Buffer.from("x"), "audio/webm");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.attempts).toBe(1);
  });

  it("a 4xx is NOT retried — the identical body gets the identical refusal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "nope" }, 400));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await transcribeWithWhisper(Buffer.from("x"), "audio/webm");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(1);
  });

  it("a 5xx IS retried", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, 503))
      .mockResolvedValueOnce(jsonResponse(OK_BODY));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await withClock(transcribeWithWhisper(Buffer.from("x"), "audio/webm"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(true);
  });

  it("an empty transcript is NOT retried — that is the answer, not a fault", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ text: "", segments: [] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await transcribeWithWhisper(Buffer.from("x"), "audio/webm");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("empty_transcript");
  });

  it("a missing base URL is not retried and costs no call at all", async () => {
    delete process.env.WHISPER_BASE_URL;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await transcribeWithWhisper(Buffer.from("x"), "audio/webm");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("whisper_base_url_missing");
  });

  it("every result carries a latency figure — the number the room path never had", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(OK_BODY)) as unknown as typeof fetch;
    const r = await transcribeWithWhisper(Buffer.from("x"), "audio/webm");
    expect(typeof r.latency_ms).toBe("number");
    expect(r.latency_ms).toBeGreaterThanOrEqual(0);
  });
});

describe("the drain names the dead transcriber", () => {
  it("WHISPER_UNAVAILABLE is a real step, and the full-window failure uses it not probe_failed", async () => {
    const src = (await import("node:fs")).readFileSync("lib/stt/room-drain.ts", "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain('"whisper_unavailable"');
    expect(code).toContain('recordFailure(windowId, "whisper_unavailable"');
    // The probe is still allowed to fail harmlessly, so `probe_failed` must not be what the
    // full-window call reports any more.
    expect(code).not.toContain('recordFailure(windowId, "probe_failed"');
  });

  it("both Whisper calls' latency reaches metrics_json and the outcome", async () => {
    const src = (await import("node:fs")).readFileSync("lib/stt/room-drain.ts", "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const key of ["whisper_probe_ms", "whisper_full_ms", "whisper_probe_attempts", "whisper_full_attempts"]) {
      expect(code).toContain(key);
    }
  });
});
