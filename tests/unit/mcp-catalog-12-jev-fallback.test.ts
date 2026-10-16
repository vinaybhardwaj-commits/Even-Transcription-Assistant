/**
 * CATALOG-12 (16 Oct 2026) — scribe_catalog get: for admin callers layers.jev falls back to catalog_c4.jev when jev_decision has no rows.
 * Same harness shape as mcp-catalog.test.ts, trimmed to what get needs. Ids and tokens are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const H = vi.hoisted(() => ({
  c4: [] as Array<Record<string, unknown>>,
  c4Throws: null as string | null,
  c4Queries: [] as string[][],
  jev: [] as Array<Record<string, unknown>>,
  jevThrows: false,
}));

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    if (/SELECT consult_uid, jev, clef_affect, presence FROM encounter_catalog/.test(text)) {
      if (H.c4Throws) return Promise.reject(Object.assign(new Error("no column"), { code: H.c4Throws }));
      const uids = values[0] as string[];
      H.c4Queries.push(uids);
      return Promise.resolve(H.c4.filter((r) => uids.includes(r.consult_uid as string)));
    }
    return Promise.resolve([]);
  };
  (sql as unknown as { transaction: unknown }).transaction = async () => [];
  return { sql, db: {} };
});
vi.mock("@/lib/r2", () => ({ getObjectRange: vi.fn(async () => null), headObject: vi.fn(async () => ({ size: null, content_type: null })), signGetUrl: vi.fn(async () => "https://signed.example/x") }));
vi.mock("@/lib/room-access/tool-reads", () => ({
  listJevDecisions: vi.fn(async () => {
    if (H.jevThrows) throw Object.assign(new Error("down"), { code: "08006" });
    return { rows: H.jev };
  }),
}));
vi.mock("@/lib/rubrics/store", () => ({ listResults: vi.fn(async () => []) }));
vi.mock("@/lib/rubrics/blind-room-days", () => ({
  BLIND_ROOM_DAYS: [],
  isBlindRoomDay: () => false,
  BlindRoomDayError: class extends Error {},
}));

import { setLabStoreForTests, ENCOUNTER_CATALOG_KEY, type LabStore } from "@/lib/sarvam-lab";
import { catalogTool } from "@/lib/mcp/tools/catalog";
import { resetCatalogCacheForTests } from "@/lib/room-access/readers/catalog-consult";
import type { ToolContext } from "@/lib/mcp/registry";
import type { McpScope } from "@/lib/mcp/auth";

const READ_CTX: ToolContext = { actor: "mcp:test", origin: "https://example.test", scopes: new Set<McpScope>(["read"]) };
const ADMIN_CTX: ToolContext = { actor: "mcp:admin:tester", origin: "https://example.test", scopes: new Set<McpScope>(["read", "admin"]) };
const getAs = async (ctx: ToolContext): Promise<Row> => (await catalogTool.handler({ action: "get", consult_uid: UID }, ctx)) as Row;
const layers = (o: Row) => o.layers as Record<string, Row>;

const UID = "UIDABCDEFGH1";
const AT = "2026-10-15T09:00:00Z";
const JEV = { sets: [{ set_id: "set_id_01", set_sha: "ab12cd34ef56", band: "high", label: "complete", model: "model-id-01", at: AT }] };
const crow = (uid: string): Row => ({
  consult_uid: uid, ist_date: "2026-10-05", doctor_uid: "doc00001", room_id: "room_a", t_open: 1_000_000, t_close: 1_600_000, source: "cutter",
  clip: { r2_key: `consult-clips/2026-10-05/opd-a/${uid}/consult.flac`, r2_status: "mirrored", signature_sha256: "c".repeat(64), audio_sha256: "a".repeat(64), bytes: 1234, minutes: 0.1 },
  layers: { stt: null, translate: null, diar_sarvam: null, diar_nemotron: null, role: null, parts: null },
  freescript: null, stages: {}, first_gap: null, allowance: { earned_min: 1, spent_min: 1 }, catalog_version: "c1", generated_at: "2026-10-14T01:00:00Z",
});
const store = new Map<string, { body: string; etag: string | null }>();
const lab: LabStore = { async get(key) { return store.get(key) ?? null; }, async put() { return "ok"; }, async list() { return []; } };
const DEC = { question_id: "q_id_01", question_set_id: "set_id_01", prompt_version: "v1", mode: "single", answer: "yes", probabilities: null, calibrated_p: null, mock: null, created_at: AT };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T06:00:00Z"));
  H.c4 = []; H.c4Throws = null; H.c4Queries = []; H.jev = []; H.jevThrows = false;
  store.clear();
  store.set(ENCOUNTER_CATALOG_KEY, { body: JSON.stringify(crow(UID)) + "\n", etag: '"e1"' });
  resetCatalogCacheForTests();
  setLabStoreForTests(lab);
});
afterEach(() => { vi.useRealTimers(); setLabStoreForTests(null); vi.restoreAllMocks(); });

describe("CATALOG-12: get layers.jev falls back to catalog_c4.jev for admin callers", () => {
  it("1 admin, jev_decision absent, C4 jev set: layers.jev is the C4 sets as stored; catalog_c4 unchanged; one encounter_catalog C4 query", async () => {
    H.c4 = [{ consult_uid: UID, jev: JEV, clef_affect: null, presence: null }];
    const o = await getAs(ADMIN_CTX);
    expect(layers(o).jev).toEqual({ status: "ok", source: ["encounter_catalog.jev (C4)"], data: { origin: "catalog_c4", sets: JEV } });
    expect(layers(o).catalog_c4).toMatchObject({ status: "ok", data: { jev: JEV, clef_affect: null, presence: null } });
    expect(H.c4Queries).toHaveLength(1);
  });

  it("2 jev_decision rows present: jev_decision wins, no merge", async () => {
    H.jev = [DEC];
    H.c4 = [{ consult_uid: UID, jev: JEV, clef_affect: null, presence: null }];
    const j = layers(await getAs(ADMIN_CTX)).jev!;
    expect(j.status).toBe("ok");
    expect(j.source).toEqual(["jev_decision (subject_type=consult)"]);
    expect(j.data).toEqual([expect.objectContaining({ question_id: "q_id_01", answer: "yes" })]);
    expect(JSON.stringify(j)).not.toContain("catalog_c4");
  });

  it("3 non-admin: jev stays absent, no catalog_c4, no C4 query", async () => {
    H.c4 = [{ consult_uid: UID, jev: JEV, clef_affect: null, presence: null }];
    const o = await getAs(READ_CTX);
    expect(layers(o).jev).toMatchObject({ status: "absent", data: null });
    expect(layers(o)).not.toHaveProperty("catalog_c4");
    expect(H.c4Queries).toEqual([]);
    const o2 = (await catalogTool.handler({ action: "get", consult_uid: UID }, { actor: "mcp:someone", origin: "https://example.test", scopes: new Set<McpScope>(["read", "admin"]) })) as Row;
    expect(layers(o2).jev).toMatchObject({ status: "absent" }); // admin scope without an admin: actor is non-admin
  });

  it("4 jev_decision read error: stays an error, no fallback", async () => {
    H.jevThrows = true;
    H.c4 = [{ consult_uid: UID, jev: JEV, clef_affect: null, presence: null }];
    const j = layers(await getAs(ADMIN_CTX)).jev!;
    expect(j.status).toBe("error");
    expect(JSON.stringify(j)).not.toContain("catalog_c4");
  });

  it("5 C4 layer absent (no row, or jev null with another column set) or error: jev unchanged (absent)", async () => {
    let j = layers(await getAs(ADMIN_CTX)).jev!;
    expect(j).toMatchObject({ status: "absent", data: null });
    H.c4 = [{ consult_uid: UID, jev: null, clef_affect: null, presence: { encounter_open: 1_760_243_000_000 } }];
    const o = await getAs(ADMIN_CTX);
    expect(layers(o).catalog_c4).toMatchObject({ status: "ok" });
    expect(layers(o).jev).toMatchObject({ status: "absent", data: null });
    H.c4Throws = "42703";
    const o2 = await getAs(ADMIN_CTX);
    expect(layers(o2).catalog_c4).toMatchObject({ status: "error" });
    j = layers(o2).jev!;
    expect(j).toMatchObject({ status: "absent", data: null });
  });

  it("help text for get carries the fallback sentence", () => {
    expect(JSON.stringify(catalogTool)).toContain("For admin callers, layers.jev falls back to catalog_c4.jev (source encounter_catalog.jev (C4)) when jev_decision has no rows.");
  });
});
