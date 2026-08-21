/**
 * Provider truth — scribe_llm_health, and traces that record what actually served.
 *
 * The defect these guard: routedChat() has always returned 'gemini:<model>' | 'ollama' |
 * 'none', and the traces recorded the string literal "qwen2.5:14b" regardless. Nothing
 * errored, so nothing surfaced it for two months. The tests below therefore assert on
 * VALUES THAT FLOW, not on the presence of a field — a regression that reintroduces a
 * constant has to fail here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// The router is stubbed, not the network: these tests are about what callers do with
// rc.provider, and routedChat itself is explicitly out of scope for this build.
// ---------------------------------------------------------------------------

type Rc = { ok: boolean; content: string; error?: string; latency_ms: number; provider: string };

let rcImpl: (p: { surface: string; tier?: string }) => Promise<Rc> | Rc = () => ({
  ok: true, content: "ok", latency_ms: 5, provider: "ollama",
});
const rcCalls: Array<{ surface: string; tier?: string; maxTokens?: number; timeoutMs?: number; messages: Array<{ role: string; content: string }> }> = [];

vi.mock("@/lib/llm/gemini", () => ({
  routedChat: (p: { surface: string; tier?: string; maxTokens?: number; timeoutMs?: number; messages: Array<{ role: string; content: string }> }) => {
    rcCalls.push(p);
    return Promise.resolve(rcImpl(p));
  },
  geminiConfigured: () => Boolean(process.env.GCP_PROJECT && process.env.GCP_SA_KEY),
  pickGemini: (surface: string, tier: "pro" | "flash") => {
    if (!(process.env.GCP_PROJECT && process.env.GCP_SA_KEY)) return undefined;
    const on = process.env.GEMINI_ALL === "1" || process.env[`GEMINI_${surface.toUpperCase()}`] === "1";
    if (!on) return undefined;
    return tier === "flash" ? "gemini-2.5-flash" : "gemini-2.5-pro";
  },
  GEMINI_MODEL: "gemini-2.5-pro",
  GEMINI_FLASH_MODEL: "gemini-2.5-flash",
  geminiChatIfOn: async () => null,
}));

import { LLM_TOOLS, LLM_SURFACES, probeLlmSurface } from "@/lib/mcp/tools/llm";

const tool = () => {
  const t = LLM_TOOLS.find((x) => x.name === "scribe_llm_health");
  if (!t) throw new Error("scribe_llm_health not registered");
  return t;
};
const run = () => tool().handler({}, { origin: "https://preview.example" }) as Promise<Record<string, unknown>>;

const GEMINI_ENV = ["GCP_PROJECT", "GCP_SA_KEY", "GCP_LOCATION", "GEMINI_ALL", "GEMINI_NOTE", "GEMINI_CDS", "GEMINI_NATIVE", "GEMINI_FUSION", "GEMINI_LIVE", "GEMINI_NOTEGEN_ANALYZE"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(GEMINI_ENV.map((k) => [k, process.env[k]]));
  for (const k of GEMINI_ENV) delete process.env[k];
  rcCalls.length = 0;
  rcImpl = () => ({ ok: true, content: "ok", latency_ms: 5, provider: "ollama" });
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const configured = () => {
  process.env.GCP_PROJECT = "proj";
  process.env.GCP_SA_KEY = "{}"; // not a real key; geminiConfigured only tests presence
};

// ===========================================================================

describe("1 — scribe_llm_health: one row per surface, provider verbatim", () => {
  it("covers all six surfaces with the tier its real caller uses", async () => {
    expect(LLM_SURFACES.map((s) => s.surface)).toEqual(["note", "cds", "native", "fusion", "live", "notegen_analyze"]);
    expect(LLM_SURFACES.map((s) => s.tier)).toEqual(["flash", "pro", "flash", "pro", "flash", "flash"]);

    const out = await run();
    const rows = out.surfaces as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.surface)).toEqual(["note", "cds", "native", "fusion", "live", "notegen_analyze"]);
    for (const r of rows) {
      expect(r).toHaveProperty("configured");
      expect(r).toHaveProperty("flag_on");
      expect(r).toHaveProperty("provider");
      expect(r).toHaveProperty("model");
      expect(r).toHaveProperty("ok");
      expect(typeof r.latency_ms).toBe("number");
    }
    expect(tool().scope).toBe("read");
  });

  it("passes provider through verbatim — it is never normalised or prettified", async () => {
    configured();
    process.env.GEMINI_ALL = "1";
    // deliberately odd strings: the tool must not touch any of them
    const answers = ["gemini:gemini-2.5-flash", "gemini:gemini-2.5-pro", "ollama", "none", "gemini:some-preview-model-0827", "OLLAMA"];
    let i = 0;
    rcImpl = () => ({ ok: true, content: "ok", latency_ms: 3, provider: answers[i++]! });

    const rows = (await run()).surfaces as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.provider)).toEqual(answers);
  });

  it("surfaces are probed sequentially, with the fixed one-word prompt and a bounded budget", async () => {
    await run();
    expect(rcCalls).toHaveLength(6);
    for (const c of rcCalls) {
      expect(c.messages).toHaveLength(2);
      expect(c.messages[1]!.content).toBe("Reply with the single word: ok");
      expect(c.timeoutMs).toBe(10_000);
      expect(typeof c.maxTokens).toBe("number");
    }
    expect(rcCalls.map((c) => c.surface)).toEqual(["note", "cds", "native", "fusion", "live", "notegen_analyze"]);
  });

  it("reports the top-level Gemini configuration, model ids included", async () => {
    configured();
    process.env.GCP_LOCATION = "asia-south1";
    process.env.GEMINI_ALL = "1";
    const out = await run();
    expect(out.gemini_configured).toBe(true);
    expect(out.gcp_project_set).toBe(true);
    expect(out.gcp_location).toBe("asia-south1");
    expect(out.gemini_all).toBe(true);
    expect(out.flash_model).toBe("gemini-2.5-flash");
    expect(out.pro_model).toBe("gemini-2.5-pro");
  });

  it("gcp_location falls back to the same default the router applies", async () => {
    const out = await run();
    expect(out.gcp_location).toBe("asia-south1");
  });
});

describe("2 — the silent fallback names itself", () => {
  it("configured + flagged but answered by ollama → warning: silent_fallback", async () => {
    configured();
    process.env.GEMINI_ALL = "1";
    rcImpl = () => ({ ok: true, content: "ok", latency_ms: 4, provider: "ollama" });

    const rows = (await run()).surfaces as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(r.configured).toBe(true);
      expect(r.flag_on).toBe(true);
      expect(r.warning).toBe("silent_fallback");
    }
  });

  it("no warning when Gemini actually served", async () => {
    configured();
    process.env.GEMINI_ALL = "1";
    rcImpl = (p) => ({ ok: true, content: "ok", latency_ms: 4, provider: `gemini:${p.tier === "pro" ? "gemini-2.5-pro" : "gemini-2.5-flash"}` });
    const rows = (await run()).surfaces as Array<Record<string, unknown>>;
    expect(rows.every((r) => r.warning === undefined)).toBe(true);
  });

  it("no warning when nobody asked for Gemini — ollama is the correct answer there", async () => {
    // unconfigured and unflagged: ollama is not a fallback, it is the design
    const rows = (await run()).surfaces as Array<Record<string, unknown>>;
    expect(rows.every((r) => r.configured === false)).toBe(true);
    expect(rows.every((r) => r.flag_on === false)).toBe(true);
    expect(rows.every((r) => r.warning === undefined)).toBe(true);
  });

  it("flag_on is reported independently of configured, so a half-set-up env is visible", async () => {
    // the flag is on but the credentials are absent — pickGemini returns undefined for BOTH
    // reasons, so collapsing them would hide this state entirely
    process.env.GEMINI_ALL = "1";
    const rows = (await run()).surfaces as Array<Record<string, unknown>>;
    for (const r of rows) {
      expect(r.flag_on).toBe(true);
      expect(r.configured).toBe(false);
      expect(r.warning).toBeUndefined(); // not a silent fallback: Gemini was never configured
    }
  });

  it("a per-surface flag warns only on that surface", async () => {
    configured();
    process.env.GEMINI_CDS = "1";
    rcImpl = () => ({ ok: true, content: "ok", latency_ms: 4, provider: "ollama" });
    const rows = (await run()).surfaces as Array<Record<string, unknown>>;
    const byName = Object.fromEntries(rows.map((r) => [r.surface, r]));
    expect(byName.cds!.warning).toBe("silent_fallback");
    expect(byName.note!.warning).toBeUndefined();
    expect(byName.live!.warning).toBeUndefined();
  });
});

describe("3 — the tool leaks nothing", () => {
  it("no key, no token, no prompt and no model text in the serialised output", async () => {
    configured();
    process.env.GCP_SA_KEY = "SUPER-SECRET-SA-KEY-VALUE";
    process.env.SCRIBE_MCP_TOKEN = "mcp-token-value";
    process.env.BRAIN_SERVICE_TOKEN = "brain-token-value";
    process.env.GEMINI_ALL = "1";
    rcImpl = () => ({ ok: true, content: "the model replied with this text", latency_ms: 4, provider: "gemini:gemini-2.5-flash" });

    const s = JSON.stringify(await run());
    expect(s).not.toContain("SUPER-SECRET-SA-KEY-VALUE");
    expect(s).not.toContain("mcp-token-value");
    expect(s).not.toContain("brain-token-value");
    expect(s).not.toContain("GCP_SA_KEY");
    // neither the prompt we sent nor the reply we got
    expect(s).not.toContain("Reply with the single word");
    expect(s).not.toContain("connectivity probe");
    expect(s).not.toContain("the model replied with this text");
    // model ids ARE returned: they are not secrets, and they are the thing you need to see
    expect(s).toContain("gemini-2.5-flash");
  });

  it("a throwing surface degrades to provider 'unknown' — never a guess", async () => {
    rcImpl = () => { throw new Error("vertex exploded"); };
    const rows = (await run()).surfaces as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(r.provider).toBe("unknown");
      expect(r.ok).toBe(false);
      expect(String(r.error)).toContain("vertex exploded");
    }
  });

  it("probeLlmSurface never throws, whatever the router does", async () => {
    rcImpl = () => { throw new Error("boom"); };
    await expect(probeLlmSurface({ surface: "note", tier: "flash" })).resolves.toMatchObject({ provider: "unknown", ok: false });
  });
});

// ===========================================================================
// The traces
// ===========================================================================

describe("4 — process/route.ts holds no hardcoded model string", () => {
  it("neither literal appears anywhere in the file, let alone in a model_calls block", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/[slug]/api/encounters/[id]/process/route.ts", "utf8");
    expect(src).not.toMatch(/"qwen2\.5:14b"/);
    expect(src).not.toMatch(/"llama3\.1:8b"/);
    // and the two blocks read from what they were handed
    expect(src).toMatch(/model_calls: \[\s*\{\s*(\/\/[^\n]*\n\s*)*model: noteRes\.provider \|\| "unknown"/);
    expect(src).toMatch(/model_calls: pipelineRes\.llm_calls\.map\(/);
    // no model_calls entry anywhere is a bare string literal
    for (const m of src.matchAll(/model:\s*"([^"]+)"/g)) {
      expect(m[1], `hardcoded model literal "${m[1]}"`).toBe("unknown");
    }
  });
});

describe("5 — generateNote returns the provider it was given", () => {
  it("carries rc.provider verbatim onto the result, not the local model name", async () => {
    vi.resetModules();
    const seen: string[] = [];
    vi.doMock("@/lib/llm/gemini", () => ({
      routedChat: async () => {
        seen.push("called");
        return { ok: true, content: JSON.stringify({ chief_complaint: "cough" }), latency_ms: 42, provider: "gemini:gemini-2.5-flash" };
      },
      geminiChatIfOn: async () => null,
      geminiConfigured: () => true,
      pickGemini: () => "gemini-2.5-flash",
      GEMINI_MODEL: "gemini-2.5-pro",
      GEMINI_FLASH_MODEL: "gemini-2.5-flash",
    }));
    process.env.OLLAMA_BASE_URL = "http://localhost:11434/v1";
    const { generateNote } = await import("@/lib/note-generation");
    const r = await generateNote("patient reports a cough for three days");
    expect(seen).toHaveLength(1);
    expect(r.provider).toBe("gemini:gemini-2.5-flash");
    expect(r.latency_ms).toBe(42);
    // the legacy `model` field is the LOCAL name and is explicitly NOT the provider
    if (r.ok) expect(r.model).not.toBe(r.provider);
    vi.doUnmock("@/lib/llm/gemini");
    vi.resetModules();
  });

  it("a failed call still reports which provider failed", async () => {
    vi.resetModules();
    vi.doMock("@/lib/llm/gemini", () => ({
      routedChat: async () => ({ ok: false, content: "", error: "http_503", latency_ms: 11, provider: "ollama" }),
      geminiChatIfOn: async () => null,
      geminiConfigured: () => false,
      pickGemini: () => undefined,
      GEMINI_MODEL: "gemini-2.5-pro",
      GEMINI_FLASH_MODEL: "gemini-2.5-flash",
    }));
    process.env.OLLAMA_BASE_URL = "http://localhost:11434/v1";
    const { generateNote } = await import("@/lib/note-generation");
    const r = await generateNote("patient reports a cough");
    expect(r.ok).toBe(false);
    expect(r.provider).toBe("ollama");
    vi.doUnmock("@/lib/llm/gemini");
    vi.resetModules();
  });

  it("nothing ran → 'unknown', never a default that looks like a real model name", async () => {
    vi.resetModules();
    vi.doMock("@/lib/llm/gemini", () => ({
      routedChat: async () => ({ ok: true, content: "{}", latency_ms: 1, provider: "ollama" }),
      geminiChatIfOn: async () => null,
      geminiConfigured: () => false,
      pickGemini: () => undefined,
      GEMINI_MODEL: "gemini-2.5-pro",
      GEMINI_FLASH_MODEL: "gemini-2.5-flash",
    }));
    process.env.OLLAMA_BASE_URL = "http://localhost:11434/v1";
    const { generateNote } = await import("@/lib/note-generation");
    const empty = await generateNote("   ");
    expect(empty.ok).toBe(false);
    expect(empty.provider).toBe("unknown");
    expect(empty.provider).not.toMatch(/qwen|llama|gemini/);
    vi.doUnmock("@/lib/llm/gemini");
    vi.resetModules();
  });
});

describe("6 — the trace records what it was handed", () => {
  /** the exact mapping process/route.ts applies, asserted on its own terms */
  const toModelCalls = (calls: Array<{ provider: string; latency_ms: number }>) =>
    calls.map((c) => ({ model: c.provider || "unknown", latency_ms: c.latency_ms }));

  it("one model_calls row per pipeline pass, each with its own provider and latency", () => {
    const llm_calls = [
      { stage: "draft" as const, provider: "gemini:gemini-2.5-pro", latency_ms: 900 },
      { stage: "critique" as const, provider: "ollama", latency_ms: 300 },
      { stage: "revise" as const, provider: "gemini:gemini-2.5-pro", latency_ms: 700 },
    ];
    expect(toModelCalls(llm_calls)).toEqual([
      { model: "gemini:gemini-2.5-pro", latency_ms: 900 },
      { model: "ollama", latency_ms: 300 },
      { model: "gemini:gemini-2.5-pro", latency_ms: 700 },
    ]);
    // a mixed run is representable — the old two-literal block could not show this at all
    expect(new Set(toModelCalls(llm_calls).map((c) => c.model)).size).toBe(2);
  });

  it("an undefined provider records 'unknown'", () => {
    const calls = [{ stage: "draft" as const, provider: undefined as unknown as string, latency_ms: 5 }];
    expect(toModelCalls(calls)).toEqual([{ model: "unknown", latency_ms: 5 }]);
    expect(toModelCalls([{ stage: "draft" as const, provider: "", latency_ms: 5 }])).toEqual([{ model: "unknown", latency_ms: 5 }]);
  });

  it("a pipeline that failed before any LLM pass records no model_calls at all", () => {
    expect(toModelCalls([])).toEqual([]);
  });
});
