/**
 * O4 (V, 8 Oct 2026): room audio never goes to Sarvam. Code rule, not a DB row.
 * Covers: the pure helper, resolveRouting('room'), roomWindowEngine, PUT /api/admin/stt-lab/routing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  routing: "sarvam",
  engines: {} as Record<string, { enabled: boolean; adapter_key: string; is_paid: boolean }>,
  transcribe: vi.fn(),
  failures: [] as string[],
  puts: [] as unknown[],
}));

vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ");
    if (q.includes("FROM stt_routing")) return [{ engine_id: H.routing }];
    if (q.includes("SELECT adapter_key FROM stt_engine") || q.includes("SELECT enabled, adapter_key FROM stt_engine")) {
      const e = H.engines[String(v[0])]; return e ? [e] : [];
    }
    if (q.includes("cost_per_min_usd FROM stt_engine")) { const e = H.engines[String(v[0])]; return e ? [{ is_paid: e.is_paid, cost_per_min_usd: null }] : []; }
    if (q.includes("FROM bench_window w JOIN bench_session")) return [{ id: "w1", session_id: "s1", room_day_id: "d1", start_ms: 0, end_ms: 900000, source_mic: "primary", room_id: "r1" }];
    if (q.includes("FROM bench_chunk")) return [{ idx: 0, source: "primary", r2_key: "k", content_type: "audio/webm", started_at: new Date(0).toISOString(), ended_at: new Date(900000).toISOString(), upload_state: "uploaded" }];
    if (q.includes("UPDATE stt_subject_job")) { H.failures.push(q); return [{ attempts: 1 }]; }
    if (q.includes("INSERT INTO stt_routing")) { H.puts.push(v); return []; }
    return [];
  },
}));
vi.mock("@/lib/r2", () => ({ getObjectBytes: async () => new Uint8Array([1, 2, 3]), deleteObject: async () => {}, signGetUrl: async () => "u" }));
vi.mock("@/lib/bench-range", () => ({
  resolveRange: () => ({ kind: "single", covering: { duration_s: 900 } }),
}));
vi.mock("@/lib/stt/registry", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  adapterFor: (k: string) => (k === "sarvam" || k === "whisper" ? { key: k, transcribe: H.transcribe, capabilities: {} } : null),
}));
vi.mock("@/lib/auth", () => ({ verifyAdminJwt: async () => ({ admin_id: "a1" }) }));
vi.mock("@/lib/cookie", () => ({ readAdminCookie: async () => "c" }));

import { isSarvamEngine, isScopeRefusal } from "@/lib/stt/o4-scope";
import { resolveRouting } from "@/lib/stt/routing";
import { roomWindowEngine } from "@/lib/stt/room-drain";
import { PUT } from "@/app/api/admin/stt-lab/routing/route";

beforeEach(() => {
  H.routing = "sarvam"; H.transcribe.mockReset(); H.failures = []; H.puts = [];
  H.engines = {
    sarvam: { enabled: true, adapter_key: "sarvam", is_paid: false }, // is_paid FALSE on purpose
    sarvam_v2: { enabled: true, adapter_key: "sarvam", is_paid: false },
    whisper: { enabled: true, adapter_key: "whisper", is_paid: false },
  };
});

describe("1. isSarvamEngine", () => {
  it("true for adapter_key sarvam or an id starting sarvam", () => {
    expect(isSarvamEngine("x", "sarvam")).toBe(true);
    expect(isSarvamEngine("sarvam")).toBe(true);
    expect(isSarvamEngine("sarvam-saaras-v3", "other")).toBe(true);
  });
  it("false otherwise", () => {
    expect(isSarvamEngine("whisper", "whisper")).toBe(false);
    expect(isSarvamEngine("route")).toBe(false);
    expect(isSarvamEngine(null, null)).toBe(false);
    expect(isSarvamEngine("my-sarvam")).toBe(false);
  });
});

describe("2. resolveRouting", () => {
  it("room + Sarvam -> typed refusal, even when is_paid is false", async () => {
    const r = await resolveRouting("room", "indic");
    expect(isScopeRefusal(r)).toBe(true);
    expect(r).toMatchObject({ refused: true, code: "scope_consult_only", engine: "sarvam" });
  });
  it("room + Sarvam is a refusal even when the engine row is disabled", async () => {
    H.engines.sarvam!.enabled = false;
    expect(isScopeRefusal(await resolveRouting("room", "english"))).toBe(true);
  });
  it("room + non-Sarvam resolves as before", async () => {
    H.routing = "whisper";
    expect(await resolveRouting("room", "english")).toBe("whisper");
  });
  it("note and live with Sarvam are still allowed", async () => {
    expect(await resolveRouting("note", "english")).toBe("sarvam");
    expect(await resolveRouting("live", "indic")).toBe("sarvam");
  });
});

describe("3. roomWindowEngine", () => {
  it("refuses Sarvam before any adapter call, with is_paid=false", async () => {
    const out = await roomWindowEngine("w1", { actor: "t", via: "test" } as never, { engine_id: "sarvam", clip_r2_key: "k", decided_language: "English" });
    expect(out.ok).toBe(false);
    expect(out.step).toBe("refused");
    expect(out.detail).toBe("refused: scope_consult_only (O4)");
    expect(H.transcribe).not.toHaveBeenCalled();
    expect(H.failures.length).toBe(1);
  });
  it("refuses a Sarvam-prefixed engine id too", async () => {
    H.engines.sarvam_v2 = H.engines.sarvam!;
    const out = await roomWindowEngine("w1", { actor: "t", via: "test" } as never, { engine_id: "sarvam", clip_r2_key: "k" });
    expect(out.step).toBe("refused");
  });
  it("does not refuse a non-Sarvam engine as O4", async () => {
    const out = await roomWindowEngine("w1", { actor: "t", via: "test" } as never, { engine_id: "whisper", clip_r2_key: "k" }).catch(() => ({ step: "threw", detail: "" }));
    expect(out.detail ?? "").not.toContain("scope_consult_only");
  });
});

describe("4. PUT /api/admin/stt-lab/routing", () => {
  const put = (b: unknown) => PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(b) }) as never);
  it("room + Sarvam -> 400 scope_consult_only, nothing written", async () => {
    const res = await put({ stage: "room", language_bucket: "indic", engine_id: "sarvam" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "scope_consult_only" });
    expect(H.puts.length).toBe(0);
  });
  it("note and live with Sarvam are unchanged (written)", async () => {
    for (const stage of ["note", "live"]) {
      const res = await put({ stage, language_bucket: "english", engine_id: "sarvam" });
      expect(res.status).toBe(200);
    }
    expect(H.puts.length).toBe(2);
  });
  it("room + a non-Sarvam engine is written", async () => {
    expect((await put({ stage: "room", language_bucket: "english", engine_id: "whisper" })).status).toBe(200);
  });
});
