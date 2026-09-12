/**
 * C1b Part B item 7 — A PAID ENGINE CANNOT BE REACHED WITHOUT BEING NAMED.
 *
 * This is the test the guard exists for. Each case is one of the ways an unattended paid call
 * could happen: the schema default, the argument omitted entirely, the literal 'auto', and a
 * routing row that already points at the paid engine. None of them may bill anyone.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * THE FIXTURE IS THE MIGRATION, and that is the whole lesson of this fix-up. The previous version
 * supplied `sarvam: 0.02` — a price NO migration sets — and so proved nothing: against the real
 * rows every paid engine has `cost_per_min_usd = NULL`, the old `cost > 0` test read them all as
 * free, and the guard stopped nothing while its tests were green. These values are read out of
 * db/migrations/ below, so the fixture cannot drift away from production again.
 */
const DB = vi.hoisted(() => ({
  engines: {} as Record<string, { is_paid: boolean; cost_per_min_usd: number | null }>,
  audits: [] as Array<Record<string, unknown>>,
  routing: "sarvam",
}));

vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ");
    if (q.includes("cost_per_min_usd FROM stt_engine")) {
      const id = String(v[0]);
      return id in DB.engines ? [DB.engines[id]] : [];
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

/** Parsed out of the seed migrations so the test cannot invent a price the system does not have. */
function seededEngines(): Record<string, { is_paid: boolean; cost_per_min_usd: number | null }> {
  const out: Record<string, { is_paid: boolean; cost_per_min_usd: number | null }> = {};
  for (const f of ["0018_stt_engine.sql", "0073_gemini_stt_engine.sql"]) {
    let sql: string;
    try { sql = readFileSync(`db/migrations/${f}`, "utf8"); } catch { continue; }
    // ('id', 'name', 'adapter', '{...}'::jsonb,\n  enabled, fanout, is_paid, cost,
    const re = /\('([a-z_]+)',\s*'[^']*',\s*'[a-z_]+',\s*'[\s\S]*?'::jsonb,\s*(true|false),\s*(true|false),\s*(true|false),\s*(NULL|[\d.]+)/g;
    for (let m = re.exec(sql); m; m = re.exec(sql)) {
      out[m[1]!] = { is_paid: m[4] === "true", cost_per_min_usd: m[5] === "NULL" ? null : Number(m[5]) };
    }
  }
  return out;
}

beforeEach(() => {
  DB.engines = seededEngines();
  DB.audits = [];
  DB.routing = "sarvam";
});

const TEN_MIN = 600_000;

describe("THE SEEDED ROWS — the guard must fire on the values migrations actually set", () => {
  it("every paid engine really is seeded is_paid=true with cost_per_min_usd NULL", () => {
    const e = seededEngines();
    // If this ever stops being true the guard's shape should be revisited — but it must be
    // asserted from the migration, never assumed.
    for (const id of ["deepgram", "sarvam", "elevenlabs", "ekascribe", "gemini"]) {
      expect(e[id], `${id} missing from the seed migrations`).toBeTruthy();
      expect(e[id]!.is_paid, `${id} must be seeded paid`).toBe(true);
      expect(e[id]!.cost_per_min_usd, `${id} is seeded UNPRICED — this is what broke the old guard`).toBeNull();
    }
    expect(e.whisper!.is_paid).toBe(false);
  });

  it("cost_per_min_usd > 0 is FALSE for every seeded engine — the old rule was inert", () => {
    const e = seededEngines();
    const anyPriced = Object.values(e).some((r) => (r.cost_per_min_usd ?? 0) > 0);
    expect(anyPriced, "no seeded engine has a positive price, so the old derivation stopped nothing").toBe(false);
  });

  it("ON THE SEEDED ROWS the guard now refuses unnamed sarvam — nine hours included", async () => {
    const { guardPaidEngine } = await import("@/lib/stt/paid-engines");
    const short = await guardPaidEngine({ engine: "sarvam", explicitlyNamed: false, durationMs: 60_000 });
    expect(short.ok, "the Refuter's exact case: unnamed sarvam at 60 s").toBe(false);
    const nineHours = await guardPaidEngine({ engine: "sarvam", explicitlyNamed: false, durationMs: 9 * 60 * 60_000 });
    expect(nineHours.ok, "and at nine hours").toBe(false);
    const gemini = await guardPaidEngine({ engine: "gemini", explicitlyNamed: false, durationMs: 900_000 });
    expect(gemini.ok, "gemini is NULL-priced BY DESIGN — Vertex bills per token").toBe(false);
  });

  it("an unpriced paid engine is still COSTED, with the conservative rate, and says so", async () => {
    const { guardPaidEngine } = await import("@/lib/stt/paid-engines");
    const { DEFAULT_PAID_RATE_USD_PER_MIN } = await import("@/lib/stt/paid-engines");
    const out = await guardPaidEngine({ engine: "sarvam", explicitlyNamed: true, durationMs: 600_000 });
    expect(out.ok).toBe(true);
    const o = out as { estimatedCostUsd: number; unpriced: boolean };
    expect(o.unpriced, "the estimate is a placeholder and the payload admits it").toBe(true);
    expect(o.estimatedCostUsd).toBe(Math.round(10 * DEFAULT_PAID_RATE_USD_PER_MIN * 10_000) / 10_000);
  });

  it("an engine with NO ROW reports free, and the residual gap is named not hidden", async () => {
    const { paidEngineInfo } = await import("@/lib/stt/paid-engines");
    const info = await paidEngineInfo("never_seen_before");
    // Deliberate: every ROUTED path already requires the row (resolveRouting reads `enabled`), so
    // a row-less engine cannot be reached that way, and failing closed here would have made the
    // free local whisper path depend on a database row it has never needed. The exposure that
    // remains — adapter present, named explicitly, no registry row — is reported, not pretended away.
    expect(info.paid).toBe(false);
    expect(info.unpriced).toBe(false);
  });
});

describe("item 6 — 'paid' is DERIVED from a column, never from a name list", () => {
  it("cost_per_min_usd > 0 is paid; 0 and NULL are free", async () => {
    const { paidEngineInfo } = await import("@/lib/stt/paid-engines");
    expect((await paidEngineInfo("sarvam")).paid, "is_paid=true, price NULL").toBe(true);
    expect((await paidEngineInfo("whisper")).paid, "is_paid=false").toBe(false);
    // NULL is "an admin has not filled the rate in yet" (0018:18), never "free".
    expect((await paidEngineInfo("sarvam")).costPerMinUsd).toBeNull();
    expect((await paidEngineInfo("sarvam")).unpriced).toBe(true);
  });

  it("A FUTURE PAID ENGINE IS CAUGHT WITH NO CODE CHANGE — the point of deriving it", async () => {
    const { guardPaidEngine } = await import("@/lib/stt/paid-engines");
    // An engine this file has never heard of, priced by a row alone.
    DB.engines["brand_new_vendor"] = { is_paid: true, cost_per_min_usd: 0.5 };
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
    expect((out as { estimatedCostUsd: number }).estimatedCostUsd).toBe(0.2); // 10 min x the default rate
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
