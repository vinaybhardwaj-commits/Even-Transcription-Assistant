/**
 * S6A — the voice console, sql mocked: every query's text and bound values are inspected, no database, no Mini, no model.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const statements: Array<{ text: string; values: unknown[] }> = [];
let answers: Record<string, Row[]> = {};
vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    statements.push({ text, values });
    for (const [k, v] of Object.entries(answers)) if (text.includes(k)) return v;
    return [];
  },
}));
const C = await import("@/lib/voice-console");
const { BLIND_ROOM_DAYS } = await import("@/lib/rubrics/blind-room-days");
const S = await import("@/lib/mcp/surface");

/** a 192-float vector as base64 whose cosine with unit-x is exactly c */
const vec = (c: number): string => {
  const f = new Float32Array(192);
  f[0] = c; f[1] = Math.sqrt(Math.max(0, 1 - c * c));
  return Buffer.from(f.buffer).toString("base64");
};
const VP = (id: string, o: Row = {}): Row => ({ clinician_id: id, sample_count: 3, enrolled_at: "2026-09-01T00:00:00Z", last_sample_at: "2026-10-01T00:00:00Z", needs_reenrollment: false, has_centroid: true, clinician_status: "active", deleted: false, matchable: true, ...o });

beforeEach(() => {
  statements.length = 0;
  answers = {
    "FROM voice_print vp LEFT JOIN clinician": [VP("docA"), VP("docB", { matchable: false, clinician_status: "disabled" })],
    "FROM voice_sample GROUP BY": [{ clinician_id: "docA", enrollment: 2, enrollment_included: 2, passive: 5, passive_included: 4, p10: 0.7123, p50: 0.8, p90: 0.91 }],
    "FROM voice_print_generation GROUP BY": [{ clinician_id: "docA", n: 2, latest_generation: 2, latest_origin: "room_audio" }],
    "FROM voice_centroid GROUP BY": [{ clinician_id: "docA", domain: "room_primary", active: 1, retired: 2 }],
    "max(rts.created_at)": [{ clinician_id: "docA", last_matched_at: "2026-10-08T05:00:00Z", n_matched_30d: 40 }],
    "rts.losing_clinician_id AS clinician_id": [{ clinician_id: "docB", n_lost_30d: 7 }],
    "SELECT count(*)::int AS n FROM room_turn_speaker rts\n      JOIN": [{ n: 3 }],
    "LEFT JOIN bench_window w": [{ n: 2 }],
  };
});

const flat = (v: unknown, out: unknown[] = []): unknown[] => { out.push(v); if (Array.isArray(v)) v.forEach((x) => flat(x, out)); else if (v && typeof v === "object") Object.values(v as object).forEach((x) => flat(x, out)); return out; };
const noVectors = (v: unknown): void => {
  for (const x of flat(v)) {
    if (Array.isArray(x) && x.length > 32 && x.every((n) => typeof n === "number")) throw new Error("a long numeric array left the server");
    if (typeof x === "string" && /^[A-Za-z0-9+/=]{100,}$/.test(x)) throw new Error("a base64 blob left the server");
    if (typeof x === "string" && /^https?:\/\//.test(x)) throw new Error("a URL left the server");
  }
};

describe("overview", () => {
  it("one row per voiceprint, active and disabled both flagged, with samples, confidence percentiles, generations, centroid counts, matches and losses", async () => {
    const o = await C.consoleOverview() as { clinicians: Row[]; summary: Row; n_blind_excluded: number; n_unplaced_excluded: number };
    expect(o.summary).toEqual({ total: 2, matchable: 1 });
    const a = o.clinicians[0]!, b = o.clinicians[1]!;
    expect(a).toMatchObject({ clinician_id: "docA", matchable: true, samples: { enrollment: 2, enrollment_included: 2, passive: 5, passive_included: 4 }, passive_match_confidence: { p10: 0.712, p50: 0.8, p90: 0.91 },
      generations: { count: 2, latest_generation: 2, latest_origin: "room_audio" }, centroids: [{ domain: "room_primary", active: 1, retired: 2 }], n_matched_30d: 40, n_lost_30d: 0 });
    expect(a.last_matched_at).toBe("2026-10-08T05:00:00.000Z");
    expect(b).toMatchObject({ clinician_id: "docB", matchable: false, clinician_status: "disabled", n_lost_30d: 7, n_matched_30d: 0, last_matched_at: null, samples: { enrollment: 0, passive: 0 } });
    expect(o.n_blind_excluded).toBe(3);
    expect(o.n_unplaced_excluded).toBe(2);
    noVectors(o);
  });
});

describe("clinician", () => {
  it("one clinician: generation history with provenance COUNTS only (ids and strings dropped), centroid rows with no embedding, a 30-day series; bad / unknown ids refused", async () => {
    answers["FROM voice_print_generation WHERE"] = [{ generation: 2, origin: "room_audio", sample_count: 9, provenance_json: { windows: 4, speech_s: 61.5, manifest: "mf_secret", ids: ["w1", "w2"] }, created_at: "2026-10-02T00:00:00Z" }];
    answers["FROM voice_centroid WHERE"] = [{ domain: "room_primary", generation: 1, embedding_model: "ecapa-192", embedding_dim: 192, n_samples: 8, created_at: "2026-10-01T00:00:00Z", retired_at: "2026-10-05T00:00:00Z", retired_by: "actor_x", retired_reason: "superseded_by:vc_y" }];
    answers["GROUP BY rd.ist_date"] = [{ day: "2026-10-07", n_matched: 12, p50: 0.8123 }];
    answers["FROM voice_print vp LEFT JOIN clinician"] = [VP("docA")];
    const r = await C.consoleClinician("docA") as Row;
    expect(r.generation_history).toEqual([{ generation: 2, origin: "room_audio", sample_count: 9, provenance_counts: { windows: 4, speech_s: 61.5 }, created_at: "2026-10-02T00:00:00.000Z" }]);
    expect(r.voice_centroids).toEqual([{ domain: "room_primary", generation: 1, embedding_model: "ecapa-192", embedding_dim: 192, n_samples: 8, created_at: "2026-10-01T00:00:00.000Z", retired_at: "2026-10-05T00:00:00.000Z", retired_by: "actor_x", retired_reason: "superseded_by:vc_y" }]);
    expect(r.daily_30d).toEqual([{ day: "2026-10-07", n_matched: 12, match_confidence_p50: 0.812 }]);
    expect(JSON.stringify(r)).not.toMatch(/mf_secret|"ids"/);
    noVectors(r);
    expect(await C.consoleClinician("bad id!")).toEqual({ ok: false, error: "bad_clinician_id" });
    answers["FROM voice_print vp LEFT JOIN clinician"] = [];
    expect(await C.consoleClinician("nobody")).toEqual({ ok: false, error: "no_voiceprint" });
  });
});

describe("pairs", () => {
  beforeEach(() => {
    answers["FROM voice_print vp JOIN clinician c"] = [{ clinician_id: "docA", b64: vec(1) }, { clinician_id: "docB", b64: vec(0.8) }, { clinician_id: "docC", b64: vec(0.55) }, { clinician_id: "docD", b64: vec(0.3) }];
    answers["GROUP BY rts.clinician_id, rts.losing_clinician_id"] = [{ won: "docA", lost: "docB", n: 5 }, { won: "docB", lost: "docA", n: 2 }, { won: "docA", lost: "docD", n: 9 }];
  });
  it("near pairs by cosine, 3 dp, sorted descending, default 0.65, with the 30-day contested counts in both directions", async () => {
    const r = await C.consolePairs() as { pairs: Row[]; label: string; min_cosine: number };
    expect(r.label).toBe("near pairs");
    expect(r.min_cosine).toBe(0.65);
    // A-B cos 0.8 ; A-C 0.55 (below 0.65) ; B-C = 0.8*0.55+0.6*0.835 ~ 0.941 ; the others are under the threshold
    const cosines = r.pairs.map((p) => p.cosine);
    expect(cosines).toEqual([...cosines].sort((a, b) => (b as number) - (a as number)));
    expect(r.pairs.find((p) => p.a === "docA" && p.b === "docB")).toEqual({ a: "docA", b: "docB", cosine: 0.8, a_won_b_lost_30d: 5, b_won_a_lost_30d: 2, n_contested_30d: 7 });
    expect(r.pairs.every((p) => (p.cosine as number) >= 0.65)).toBe(true);
    expect(r.pairs.some((p) => p.a === "docA" && p.b === "docC")).toBe(false);
    for (const p of r.pairs) expect(String(p.cosine)).toMatch(/^\d(\.\d{1,3})?$/);
    noVectors(r);
  });
  it("the floor is 0.50 whatever is asked: a lower min_cosine is raised to 0.5, a higher one honoured, junk falls back to the default", async () => {
    const low = await C.consolePairs(0.1) as { min_cosine: number; pairs: Row[] };
    expect(low.min_cosine).toBe(0.5);
    expect(low.pairs.some((p) => p.a === "docA" && p.b === "docC")).toBe(true); // 0.55 now passes
    expect(low.pairs.some((p) => p.a === "docA" && p.b === "docD")).toBe(false); // 0.3 never
    expect((await C.consolePairs(0.9) as { pairs: Row[] }).pairs.map((p) => `${p.a}${p.b}`)).toEqual(["docCdocD", "docBdocC"]); // 0.962, 0.941 (the planar test vectors)
    expect((await C.consolePairs(Number.NaN) as { min_cosine: number }).min_cosine).toBe(0.65);
    expect(C.PAIRS_COSINE_FLOOR).toBe(0.5);
  });
  it("only ACTIVE clinicians with a centroid are compared (the query says so) and the vectors never leave: only the cosine does", async () => {
    await C.consolePairs();
    const q = statements.find((s) => /encode\(vp\.centroid/.test(s.text))!;
    expect(q.text).toMatch(/c\.status = 'active' AND c\.deleted_at IS NULL/);
    noVectors(await C.consolePairs());
  });
});

describe("held-out room-days and what may be selected", () => {
  it("every room_turn_speaker aggregate (overview, clinician, pairs) excludes the 14 pairs IN SQL, before the GROUP BY; the excluded counts are separate queries", async () => {
    await C.consoleOverview(); await C.consolePairs();
    answers["FROM voice_print vp LEFT JOIN clinician"] = [VP("docA")];
    await C.consoleClinician("docA");
    const agg = statements.filter((s) => /FROM room_turn_speaker rts/.test(s.text) && /GROUP BY/.test(s.text));
    expect(agg.length).toBeGreaterThanOrEqual(5); // matched, lost, daily series, pairs (x2 views)
    for (const q of agg) {
      expect(q.text, q.text.slice(0, 80)).toMatch(/NOT EXISTS \(SELECT 1 FROM room_day r1, unnest\(\?::date\[\], \?::text\[\]\) AS b\(d, r\) WHERE r1\.id IN \(rts\.room_day_id, w\.room_day_id, dw\.room_day_id\) AND b\.d = r1\.ist_date AND b\.r = r1\.room_id\)/); // B2: ANY placement
      expect(q.text.indexOf("NOT EXISTS")).toBeLessThan(q.text.indexOf("GROUP BY"));
      expect(q.values).toContainEqual(BLIND_ROOM_DAYS.map(([d]) => d));
      expect(q.values).toContainEqual(BLIND_ROOM_DAYS.map(([, r]) => r));
      expect(q.text).toMatch(/JOIN bench_window w ON w\.id = rts\.window_id JOIN room_day rd ON rd\.id = w\.room_day_id/);
    }
    const ex = statements.filter((s) => /count\(\*\)::int AS n FROM room_turn_speaker/.test(s.text));
    expect(ex.some((q) => /EXISTS \(SELECT 1 FROM room_day r1, unnest/.test(q.text) && !/NOT EXISTS/.test(q.text))).toBe(true); // the blind count
    expect(ex.some((q) => /rd\.id IS NULL/.test(q.text))).toBe(true); // the unplaced count
  });
  it("no query selects a vector column, samples_json, an audio key or a presign; the only vector read is encode(centroid) for the pair view", async () => {
    await C.consoleOverview(); await C.consolePairs();
    answers["FROM voice_print vp LEFT JOIN clinician"] = [VP("docA")];
    await C.consoleClinician("docA");
    for (const s of statements) {
      if (/encode\(vp\.centroid/.test(s.text)) { expect(s.text).toMatch(/FROM voice_print vp JOIN clinician c/); continue; } // the pair view's one read, compared in memory and dropped
      expect(s.text, s.text.slice(0, 60)).not.toMatch(/samples_json|audio_r2_key|\bembedding\b\s*[,\n]|SELECT[^;]*\bcentroid\b\s*,/i);
    }
    expect(statements.filter((s) => /encode\(/.test(s.text))).toHaveLength(1);
  });
});

describe("the tool", () => {
  it("is a read tool in the scribe_voice group (view=console), refuses unknown actions and a missing clinician_id, and carries no URL", async () => {
    const tool = S.CALLABLE_TOOLS.get("scribe_voice_console")!;
    expect(tool.scope).toBe("read");
    const ctx = { origin: "https://x", actor: "mcp:t", scopes: new Set(["read"]) } as never;
    expect(await tool.handler({ action: "nope" }, ctx)).toMatchObject({ ok: false, error: "unknown_action" });
    expect(await tool.handler({ action: "clinician" }, ctx)).toEqual({ ok: false, error: "clinician_id_required" });
    const o = await tool.handler({ action: "overview" }, ctx) as Row;
    expect(o.ok).toBe(true);
    noVectors(o);
    const group = S.CALLABLE_TOOLS.get("scribe_voice")!;
    expect(JSON.stringify(group.inputSchema)).toMatch(/console/);
  });
});
