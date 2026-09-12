/**
 * C1b Part B item 7 — A PAID ENGINE CANNOT BE REACHED WITHOUT BEING NAMED.
 *
 * This is the test the guard exists for. Each case is one of the ways an unattended paid call
 * could happen: the schema default, the argument omitted entirely, the literal 'auto', and a
 * routing row that already points at the paid engine. None of them may bill anyone.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const DB = vi.hoisted(() => ({
  cost: {} as Record<string, number | null>,
  audits: [] as Array<Record<string, unknown>>,
  routing: "sarvam",
}));

vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ");
    if (q.includes("cost_per_min_usd FROM stt_engine")) {
      const id = String(v[0]);
      return id in DB.cost ? [{ cost_per_min_usd: DB.cost[id] }] : [];
    }
    if (q.includes("INSERT INTO audit_log")) {
      // actor_type, action and target_type are LITERALS in the statement, not bound values —
      // so the action is read off the query text and only three params are bound.
      DB.audits.push({ actor: v[0], target: v[1], meta: JSON.parse(String(v[2])),
                       action: /'(stt\.[a-z_]+)'/.exec(q)?.[1] ?? null });
      return [];
    }
    if (q.includes("FROM stt_routing")) return [{ engine_id: DB.routing }];
    if (q.includes("FROM stt_engine")) return [{ enabled: true }];
    return [];
  },
}));

beforeEach(() => {
  DB.cost = { sarvam: 0.02, whisper: 0, route: null, deepgram: 0.0043 };
  DB.audits = [];
  DB.routing = "sarvam";
});

const TEN_MIN = 600_000;

describe("item 6 — 'paid' is DERIVED from the cost column, never from a name list", () => {
  it("cost_per_min_usd > 0 is paid; 0 and NULL are free", async () => {
    const { paidEngineInfo } = await import("@/lib/stt/paid-engines");
    expect((await paidEngineInfo("sarvam")).paid).toBe(true);
    expect((await paidEngineInfo("whisper")).paid).toBe(false);
    expect((await paidEngineInfo("route")).paid, "NULL cost is free, not unknown-so-refuse").toBe(false);
  });

  it("A FUTURE PAID ENGINE IS CAUGHT WITH NO CODE CHANGE — the point of deriving it", async () => {
    const { guardPaidEngine } = await import("@/lib/stt/paid-engines");
    // An engine this file has never heard of, priced by a row alone.
    DB.cost["brand_new_vendor"] = 0.5;
    const out = await guardPaidEngine({ engine: "brand_new_vendor", explicitlyNamed: false, durationMs: 60_000 });
    expect(out.ok, "no array to add it to; the column caught it").toBe(false);
    expect((out as { error: string }).error).toBe("paid_engine_must_be_named");
  });

  it("a free engine is never capped and never audited", async () => {
    const { guardPaidEngine } = await import("@/lib/stt/paid-engines");
    const out = await guardPaidEngine({ engine: "whisper", explicitlyNamed: false, durationMs: 9 * 60 * 60_000 });
    expect(out.ok).toBe(true);
    expect((out as { paid: boolean }).paid).toBe(false);
  });
});

describe("item 7 — every route to an UNNAMED paid call is closed", () => {
  it("(a) NOT NAMED — the schema default or an omitted argument", async () => {
    const { guardPaidEngine } = await import("@/lib/stt/paid-engines");
    const out = await guardPaidEngine({ engine: "sarvam", explicitlyNamed: false, durationMs: 60_000 });
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toBe("paid_engine_must_be_named");
  });

  it("(b) 'auto' is refused by the TOOL before it can become an engine at all", async () => {
    const { BENCH_TOOLS } = await import("@/lib/mcp/tools/bench");
    const t = BENCH_TOOLS.find((x) => x.name === "scribe_transcribe_range")!;
    const out = (await t.handler({ session_id: "s", start: "10:00", end: "10:01", engine: "auto" },
      { actor: "mcp:op", scopes: new Set(["read", "invoke"]), origin: "https://x" } as never)) as Record<string, unknown>;
    expect(out.error).toBe("engine_auto_not_allowed");
  });

  it("(b2) THE ASYNC PATH refuses a named engine rather than silently running whisper", async () => {
    const { BENCH_TOOLS } = await import("@/lib/mcp/tools/bench");
    const t = BENCH_TOOLS.find((x) => x.name === "scribe_transcribe_range")!;
    const out = (await t.handler({ session_id: "s", start: "10:00", end: "10:01", engine: "sarvam", async: true },
      { actor: "mcp:op", scopes: new Set(["read", "invoke"]), origin: "https://x" } as never)) as Record<string, unknown>;
    expect(out.error, "a dropped engine arg would be a silent wrong-engine result").toBe("engine_not_supported_on_async");
  });

  it("(c) ROUTING INHERITANCE — a routing row pointing at the paid engine grants nothing", async () => {
    const { guardPaidEngine } = await import("@/lib/stt/paid-engines");
    const { resolveRouting } = await import("@/lib/stt/routing");
    // The routing table really does say sarvam...
    expect(await resolveRouting("room", "indic")).toBe("sarvam");
    // ...and it still is not a naming. Inheriting a row is precisely an UNATTENDED spend.
    const out = await guardPaidEngine({ engine: "sarvam", explicitlyNamed: false, durationMs: 60_000 });
    expect(out.ok, "a routing row is configuration, not a person asking").toBe(false);
  });

  it("(d) NAMED, but too long — bounded as well as explicit", async () => {
    const { guardPaidEngine, PAID_MAX_DURATION_MS } = await import("@/lib/stt/paid-engines");
    expect(PAID_MAX_DURATION_MS).toBe(TEN_MIN);
    const out = await guardPaidEngine({ engine: "sarvam", explicitlyNamed: true, durationMs: PAID_MAX_DURATION_MS + 1 });
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toBe("paid_engine_duration_cap");
    expect((out as { limit_ms: number }).limit_ms).toBe(PAID_MAX_DURATION_MS);
    // A whole room-day cannot be billed by one call: 8 h is far past the cap.
    const day = await guardPaidEngine({ engine: "sarvam", explicitlyNamed: true, durationMs: 8 * 60 * 60_000 });
    expect(day.ok).toBe(false);
  });

  it("NAMED and within the cap is allowed, and only then", async () => {
    const { guardPaidEngine, PAID_MAX_DURATION_MS } = await import("@/lib/stt/paid-engines");
    const out = await guardPaidEngine({ engine: "sarvam", explicitlyNamed: true, durationMs: PAID_MAX_DURATION_MS });
    expect(out.ok, "the cap is inclusive").toBe(true);
    expect((out as { paid: boolean }).paid).toBe(true);
    expect((out as { estimatedCostUsd: number }).estimatedCostUsd).toBe(0.2); // 10 min x $0.02
  });
});

describe("item 6 — attributable, and the operator sees the spend", () => {
  it("one audit row per paid call, carrying actor, engine, duration and estimated cost", async () => {
    const { recordPaidCall } = await import("@/lib/stt/paid-engines");
    await recordPaidCall({ actor: "mcp:operator-v1", engine: "sarvam", durationMs: 300_000, estimatedCostUsd: 0.1, costPerMinUsd: 0.02, subject: "sess:0-300000" });
    expect(DB.audits).toHaveLength(1);
    const a = DB.audits[0]!;
    expect(a.actor).toBe("mcp:operator-v1");
    expect(a.action).toBe("stt.paid_call");
    expect(a.target).toBe("sarvam");
    const meta = a.meta as Record<string, unknown>;
    expect(meta.engine).toBe("sarvam");
    expect(meta.duration_ms).toBe(300_000);
    expect(meta.audio_minutes).toBe(5);
    expect(meta.estimated_cost_usd).toBe(0.1);
    expect(meta.cost_per_min_usd).toBe(0.02);
  });

  it("an audit write that FAILS never takes the transcription with it", async () => {
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({ sql: async () => { throw new Error("audit table gone"); } }));
    const { recordPaidCall } = await import("@/lib/stt/paid-engines");
    await expect(recordPaidCall({ actor: "a", engine: "sarvam", durationMs: 1000, estimatedCostUsd: 0, costPerMinUsd: 0.02 })).resolves.toBeUndefined();
    vi.doUnmock("@/lib/db");
    vi.resetModules();
  });

  it("the estimate is the audio's own minutes times the row's rate", async () => {
    const { estimateCostUsd } = await import("@/lib/stt/paid-engines");
    expect(estimateCostUsd(0.02, 600_000)).toBe(0.2);
    expect(estimateCostUsd(0.0043, 60_000)).toBe(0.0043);
    expect(estimateCostUsd(null, 600_000), "no rate means no claim about cost").toBeNull();
    expect(estimateCostUsd(0, 600_000)).toBeNull();
  });
});
