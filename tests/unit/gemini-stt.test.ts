/**
 * Build 3 §A — the Gemini STT adapter.
 *
 * The rule with the most history behind it: THIS ADAPTER NEVER FALLS BACK. `routedChat()` soft-
 * fails to local Ollama on any Gemini error, and `lib/brain/fuse/gemini-arms.ts` records what
 * that cost — 367 audits labelled `gemini-2.5-pro` actually served by `qwen2.5:14b` for four
 * days, with nothing anywhere saying so. A lab engine that can be silently substituted measures
 * nothing. Several tests below exist purely to prove no such path is reachable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The token exchange is mocked so these tests exercise the ADAPTER, not Google's OAuth. The one
 * test that cares about a bad credential un-mocks it explicitly.
 *
 * `GCP_SA_KEY` still has to be PRESENT in the environment for the adapter's own pre-flight check,
 * which is the behaviour under test in "missing project or key refuses before the network".
 */
vi.mock("@/lib/gcp-auth", () => ({
  getVertexAccessToken: vi.fn(async () => {
    if (process.env.GCP_SA_KEY === "not-json") throw new Error("GCP_SA_KEY is not valid JSON (or base64 JSON)");
    return "test-token";
  }),
}));

/** Source with comments stripped — an assertion about what the code DOES must not read the prose
 *  explaining what it deliberately avoids. The header names `routedChat` precisely to say it is
 *  not used, and a raw substring scan would fail on the explanation. */
const codeOf = (f: string): string =>
  readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
import {
  geminiAdapter,
  readConfig,
  generateContentUrl,
  baseMime,
  isMimeAllowed,
  deriveCostUsd,
  reportedModel,
  parseGenerateContent,
  GEMINI_AUDIO_MIME_ALLOWLIST,
} from "@/lib/stt/adapters/gemini";
import { ADAPTERS, adapterFor } from "@/lib/stt/registry";

const AUDIO = Buffer.from("fake-audio-bytes");
const OGG = { contentType: "audio/ogg" };

/** A full environment with every gate armed, so each test can remove exactly one thing. */
const ARMED = {
  GEMINI_STT: "1",
  GEMINI_STT_MODEL: "gemini-3.7-flash",
  GCP_PROJECT: "proj-x",
  GCP_LOCATION: "global",
  GCP_SA_KEY: "{}",
};

function setEnv(over: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else process.env[k] = v;
  }
}

const ENV_KEYS = [
  "GEMINI_STT", "GEMINI_STT_MODEL", "GCP_PROJECT", "GCP_LOCATION", "GCP_SA_KEY",
  "GEMINI_STT_ALLOW_MIME", "GEMINI_STT_USD_PER_1K_INPUT_TOKENS", "GEMINI_STT_USD_PER_1K_OUTPUT_TOKENS",
];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete (process.env as Record<string, string | undefined>)[k];
});
afterEach(() => {
  setEnv(saved);
  vi.restoreAllMocks();
});

const okBody = (text = "the patient reports chest pain") => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500 },
  modelVersion: "gemini-3.7-flash-001",
});

const jsonRes = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
}) as unknown as Response;

describe("the gate and the config — nothing is silently chosen", () => {
  it("gate off: transcribe refuses and makes NO network call", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await geminiAdapter.transcribe(AUDIO, OGG);
    expect(r.error).toBe("gemini_stt_disabled");
    expect(r.original).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gate on with NO model is a LOUD error, never a silently-picked default", async () => {
    setEnv({ ...ARMED, GEMINI_STT_MODEL: undefined });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await geminiAdapter.transcribe(AUDIO, OGG);
    expect(r.error).toBe("gemini_stt_model_unset");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an empty-string model is unset, not a model named ''", () => {
    expect(readConfig({ ...ARMED, GEMINI_STT_MODEL: "   " }).model).toBeNull();
  });

  it("there is NO default model anywhere in the adapter source", () => {
    const src = codeOf("lib/stt/adapters/gemini.ts");
    // The failure being prevented: `process.env.GEMINI_STT_MODEL || "gemini-something"`.
    expect(src).not.toMatch(/GEMINI_STT_MODEL\]?\s*(\|\||\?\?)\s*["'`]gemini/);
  });

  it("only the exact string \"1\" arms the gate", () => {
    for (const v of ["0", "true", "yes", "", undefined]) {
      expect(readConfig({ ...ARMED, GEMINI_STT: v }).gateOn).toBe(false);
    }
    expect(readConfig(ARMED).gateOn).toBe(true);
  });

  it("missing project or key refuses before the network", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    setEnv({ ...ARMED, GCP_PROJECT: undefined });
    expect((await geminiAdapter.transcribe(AUDIO, OGG)).error).toBe("gcp_project_unset");
    setEnv({ ...ARMED, GCP_SA_KEY: undefined });
    expect((await geminiAdapter.transcribe(AUDIO, OGG)).error).toBe("gcp_sa_key_unset");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fail closed on every error class — no fallback is reachable", () => {
  it("the adapter never imports the helper that falls back to Ollama", () => {
    const src = codeOf("lib/stt/adapters/gemini.ts");
    expect(src).not.toContain("routedChat");
    expect(src).not.toContain("geminiChatIfOn");
    expect(src).not.toContain("from \"@/lib/llm/gemini\"");
    expect(src).not.toContain("ollama");
    expect(src).not.toContain("OLLAMA");
  });

  it("every failure returns the error state with a null transcript", async () => {
    setEnv(ARMED);
    const cases: Array<[string, () => void, string]> = [
      ["http 500", () => { globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({ e: 1 }, 500)) as never; }, "http_500"],
      ["http 403", () => { globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({ e: 1 }, 403)) as never; }, "http_403"],
      ["network", () => { globalThis.fetch = vi.fn().mockRejectedValue(new Error("socket hang up")) as never; }, "network:"],
      ["malformed", () => { globalThis.fetch = vi.fn().mockResolvedValue(jsonRes(null)) as never; }, "malformed_response"],
      ["empty candidates", () => { globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({ candidates: [] })) as never; }, "empty_candidates"],
    ];
    for (const [label, arrange, expected] of cases) {
      arrange();
      const r = await geminiAdapter.transcribe(AUDIO, OGG);
      expect(r.original, label).toBeNull();
      expect(r.english, label).toBeNull();
      expect(r.error, label).toContain(expected);
    }
  });

  it("a 429 is named rate_limited — the CDMSS 403s were a concurrency quota, not IAM", async () => {
    setEnv(ARMED);
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({ e: "quota" }, 429)) as never;
    const r = await geminiAdapter.transcribe(AUDIO, OGG);
    expect(r.error).toContain("rate_limited");
  });

  it("a bad credential becomes an error state, never a thrown exception", async () => {
    // The mock throws for exactly this value, reproducing loadServiceAccount's real behaviour.
    setEnv({ ...ARMED, GCP_SA_KEY: "not-json" });
    const r = await geminiAdapter.transcribe(AUDIO, OGG);
    expect(r.error).toContain("auth_failed");
    expect(r.original).toBeNull();
  });

  it("A 200 IS NOT A SUCCESS — a truncated answer is an error, not a short transcript", () => {
    const truncated = { candidates: [{ content: { parts: [{ text: "half a transcr" }] }, finishReason: "MAX_TOKENS" }] };
    const r = parseGenerateContent(truncated);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("finish_max_tokens");
  });

  it("every non-STOP finish reason refuses", () => {
    for (const reason of ["MAX_TOKENS", "SAFETY", "RECITATION"]) {
      const r = parseGenerateContent({ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: reason }] });
      expect(r.ok).toBe(false);
    }
  });

  it("a blocked prompt is named", () => {
    const r = parseGenerateContent({ promptFeedback: { blockReason: "SAFETY" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("blocked:SAFETY");
  });

  it("an empty transcript is an error, not an empty success", () => {
    const r = parseGenerateContent({ candidates: [{ content: { parts: [{ text: "   " }] }, finishReason: "STOP" }] });
    expect(r.ok).toBe(false);
  });
});

describe("the MIME guard refuses before spending", () => {
  it("audio/webm — what the drain actually sends — is NOT accepted", async () => {
    setEnv(ARMED);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await geminiAdapter.transcribe(AUDIO, { contentType: "audio/webm" });
    expect(r.error).toBe("unsupported_audio_mime:audio/webm");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("webm is absent from the allowlist, and the documented containers are present", () => {
    expect(GEMINI_AUDIO_MIME_ALLOWLIST).not.toContain("audio/webm");
    for (const m of ["audio/wav", "audio/mp3", "audio/aiff", "audio/aac", "audio/ogg", "audio/flac"]) {
      expect(GEMINI_AUDIO_MIME_ALLOWLIST).toContain(m);
    }
  });

  it("codec parameters do not defeat the guard", () => {
    expect(baseMime("audio/ogg; codecs=opus")).toBe("audio/ogg");
    expect(isMimeAllowed("audio/ogg; codecs=opus", GEMINI_AUDIO_MIME_ALLOWLIST)).toBe(true);
    expect(isMimeAllowed("audio/webm; codecs=opus", GEMINI_AUDIO_MIME_ALLOWLIST)).toBe(false);
  });

  it("the allowlist is overridable from env so a real probe lands without a deploy", () => {
    const cfg = readConfig({ ...ARMED, GEMINI_STT_ALLOW_MIME: "audio/webm, audio/ogg" });
    expect(isMimeAllowed("audio/webm", cfg.allowedMime)).toBe(true);
  });
});

describe("cost is DERIVED from usage, or null — never zero, never a guess", () => {
  const rates = { GEMINI_STT_USD_PER_1K_INPUT_TOKENS: "0.001", GEMINI_STT_USD_PER_1K_OUTPUT_TOKENS: "0.002" };

  it("computed from the usage block of the call just made", () => {
    const cost = deriveCostUsd({ promptTokenCount: 1000, candidatesTokenCount: 500 }, rates);
    expect(cost).toBeCloseTo(0.001 + 0.001, 9);
  });

  it("NULL when the response carried no usage — not 0", () => {
    expect(deriveCostUsd(undefined, rates)).toBeNull();
    expect(deriveCostUsd(null, rates)).toBeNull();
    expect(deriveCostUsd({}, rates)).toBeNull();
  });

  it("NULL when no rate is configured — an unpriced token count is not a cost", () => {
    expect(deriveCostUsd({ promptTokenCount: 1000, candidatesTokenCount: 500 }, {})).toBeNull();
  });

  it("the adapter never estimates from duration", () => {
    const src = codeOf("lib/stt/adapters/gemini.ts");
    expect(src).not.toContain("estimateCostUsd");
    expect(src).not.toContain("DEFAULT_PAID_RATE");
  });

  it("a successful call carries the derived cost through", async () => {
    setEnv({ ...ARMED, ...rates });
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes(okBody())) as never;
    const r = await geminiAdapter.transcribe(AUDIO, OGG);
    expect(r.error).toBeNull();
    expect(r.costUsd).toBeCloseTo(0.002, 9);
  });

  it("a success with no usage block reports a null cost, not a free call", async () => {
    setEnv({ ...ARMED, ...rates });
    const noUsage = { candidates: [{ content: { parts: [{ text: "hello" }] }, finishReason: "STOP" }] };
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes(noUsage)) as never;
    const r = await geminiAdapter.transcribe(AUDIO, OGG);
    expect(r.error).toBeNull();
    expect(r.costUsd).toBeNull();
  });
});

describe("engineVersion comes off the RESPONSE, never from a constant", () => {
  it("it is read from the response body", () => {
    expect(reportedModel({ modelVersion: "gemini-3.7-flash-001" })).toBe("gemini-3.7-flash-001");
    expect(reportedModel({ model: "gemini-3.1-pro-preview" })).toBe("gemini-3.1-pro-preview");
  });

  it("null when the response reports none — receipt_complete stays false, visibly", () => {
    expect(reportedModel({})).toBeNull();
    expect(reportedModel(null)).toBeNull();
    expect(reportedModel({ modelVersion: "  " })).toBeNull();
  });

  it("a live call reports the RESPONSE's model even when it differs from the one we asked for", async () => {
    setEnv({ ...ARMED, GEMINI_STT_MODEL: "gemini-3.7-flash" });
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({ ...okBody(), modelVersion: "gemini-3.7-flash-002" })) as never;
    const r = await geminiAdapter.transcribe(AUDIO, OGG);
    // The decisive assertion: it is NOT the env value we sent.
    expect(r.engineVersion).toBe("gemini-3.7-flash-002");
    expect(r.engineVersion).not.toBe(process.env.GEMINI_STT_MODEL);
  });

  it("the adapter never assigns engineVersion from the env or a literal", () => {
    const src = codeOf("lib/stt/adapters/gemini.ts");
    expect(src).not.toMatch(/engineVersion:\s*cfg\.model/);
    expect(src).not.toMatch(/engineVersion:\s*["'`]/);
    expect(src).toContain("engineVersion: reportedModel(body)");
  });
});

describe("what this engine does NOT claim", () => {
  it("language is null — there is no language parameter, so any value would be invented", async () => {
    setEnv(ARMED);
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes(okBody())) as never;
    const r = await geminiAdapter.transcribe(AUDIO, { contentType: "audio/ogg", language: "hi-IN" });
    expect(r.language).toBeNull();
  });

  it("english is null — no translate call was made", async () => {
    setEnv(ARMED);
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes(okBody())) as never;
    expect((await geminiAdapter.transcribe(AUDIO, OGG)).english).toBeNull();
  });

  it("capabilities do not advertise translation or segmentation", () => {
    expect(geminiAdapter.capabilities.translates).toBe(false);
    expect(geminiAdapter.capabilities.streaming).toBe(false);
    expect(geminiAdapter.capabilities.tiers).toEqual(["asr"]);
  });

  it("it hits the native generateContent endpoint, not the usage-discarding compat one", () => {
    const url = generateContentUrl({ project: "p", location: "global", model: "m" });
    expect(url).toBe("https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/m:generateContent");
    expect(url).not.toContain("endpoints/openapi");
    expect(generateContentUrl({ project: "p", location: "asia-south1", model: "m" }))
      .toContain("asia-south1-aiplatform.googleapis.com");
  });
});

describe("registration", () => {
  it("the adapter is in the registry under its own key", () => {
    expect(adapterFor("gemini")).toBe(geminiAdapter);
    expect(ADAPTERS.gemini).toBeDefined();
    expect(geminiAdapter.key).toBe("gemini");
  });

  it("registration alone does not run it — the row ships fanout_enabled=false and unrouted", () => {
    const sql = readFileSync("db/migrations/0073_gemini_stt_engine.sql", "utf8");
    expect(sql).toContain("true, false, true, NULL");   // enabled, fanout_enabled, is_paid, cost_per_min
    expect(sql).not.toMatch(/UPDATE\s+stt_routing/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+stt_routing/i);
    expect(sql).toContain("(73, '0073_gemini_stt_engine')");
  });

  it("config_json holds env NAMES, never values — the house convention since 0018", () => {
    const sql = readFileSync("db/migrations/0073_gemini_stt_engine.sql", "utf8");
    expect(sql).toContain('"model_env":"GEMINI_STT_MODEL"');
    expect(sql).toContain('"gate_env":"GEMINI_STT"');
    // No "model" key: this engine has no default model on purpose.
    expect(sql).not.toContain('"model":"gemini');
  });
});
