/**
 * CATALOG-13 (16 Oct 2026) — scribe_catalog: no_clip on clip_audio_url / clip_audio_chunk, and action=explorer_link. Same harness shape as mcp-catalog-12-jev-fallback / mcp-catalog.test.ts,
 * trimmed. Ids and tokens are synthetic and id-shaped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const H = vi.hoisted(() => ({ sql: 0, r2: 0, signed: 0 }));

vi.mock("@/lib/db", () => {
  const sql = () => { H.sql += 1; return Promise.resolve([]); };
  (sql as unknown as { transaction: unknown }).transaction = async () => { H.sql += 1; return []; };
  return { sql, db: {} };
});
vi.mock("@/lib/r2", () => ({
  getObjectRange: vi.fn(async () => { H.r2 += 1; return null; }),
  headObject: vi.fn(async () => { H.r2 += 1; return { size: null, content_type: null }; }),
  signGetUrl: vi.fn(async () => { H.signed += 1; return "https://signed.example/clip?sig=placeholder"; }),
}));
vi.mock("@/lib/room-access/tool-reads", () => ({ listJevDecisions: vi.fn(async () => ({ rows: [] })) }));
vi.mock("@/lib/rubrics/store", () => ({ listResults: vi.fn(async () => []) }));
vi.mock("@/lib/rubrics/blind-room-days", () => ({
  BLIND_ROOM_DAYS: [],
  isBlindRoomDay: () => false,
  BlindRoomDayError: class extends Error {},
}));

import { setLabStoreForTests, ENCOUNTER_CATALOG_KEY, type LabStore } from "@/lib/sarvam-lab";
import { catalogTool } from "@/lib/mcp/tools/catalog";
import { resetCatalogCacheForTests, clipAbsent, sealReasonOf } from "@/lib/room-access/readers/catalog-consult";
import type { ToolContext } from "@/lib/mcp/registry";
import type { McpScope } from "@/lib/mcp/auth";

const READ_CTX: ToolContext = { actor: "mcp:test", origin: "https://example.test", scopes: new Set<McpScope>(["read"]) };
const ADMIN_CTX: ToolContext = { actor: "mcp:admin:tester", origin: "https://example.test", scopes: new Set<McpScope>(["read", "admin"]) };
const call = async (args: Row, ctx: ToolContext = READ_CTX): Promise<Row> => (await catalogTool.handler(args, ctx)) as Row;

const UID = "UIDABCDEFGH1";
const DAY = "2026-10-05";
const GOOD_KEY = (uid = UID) => `consult-clips/${DAY}/opd-a/${uid}/consult.flac`;
const crow = (uid: string, clip: unknown): Row => ({
  consult_uid: uid, ist_date: DAY, doctor_uid: "doc00001", room_id: "room_a", t_open: 1_000_000, t_close: 1_600_000, source: "cutter", clip,
  layers: {}, freescript: null, stages: {}, first_gap: null, allowance: { earned_min: 1, spent_min: 1 }, catalog_version: "c1", generated_at: "2026-10-14T01:00:00Z",
});
const store = new Map<string, { body: string; etag: string | null }>();
let labGets = 0;
const lab: LabStore = { async get(key) { labGets += 1; return store.get(key) ?? null; }, async put() { return "ok"; }, async list() { return []; } };
const setRows = (rows: Row[]) => store.set(ENCOUNTER_CATALOG_KEY, { body: rows.map((r) => JSON.stringify(r)).join("\n") + "\n", etag: '"e1"' });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T06:00:00Z"));
  H.sql = 0; H.r2 = 0; H.signed = 0; labGets = 0;
  store.clear(); resetCatalogCacheForTests(); setLabStoreForTests(lab);
  vi.stubEnv("SCRIBE_EXPLORER_URL", "https://claude.ai/artifact/explorer_01");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); setLabStoreForTests(null); vi.restoreAllMocks(); });

describe("Part A: no_clip", () => {
  const cases: Array<[string, unknown]> = [
    ["null key", { r2_key: null, sealed: "skipped:final_no_session" }],
    ["absent key", { sealed: "skipped:final_no_session", bytes: null }],
    ["empty key", { r2_key: "", sealed: "skipped:final_no_session" }],
    ["no clip object", undefined],
    ["clip null", null],
  ];

  it.each(cases)("%s: both clip actions answer no_clip with the stored seal token; nothing is signed or read from R2", async (_n, clip) => {
    setRows([crow(UID, clip)]);
    const want = clip && typeof clip === "object" && "sealed" in clip ? "skipped:final_no_session" : null;
    expect(await call({ action: "clip_audio_url", consult_uid: UID })).toEqual({ ok: false, error: "no_clip", sealed: want });
    expect(await call({ action: "clip_audio_chunk", consult_uid: UID })).toEqual({ ok: false, error: "no_clip", sealed: want });
    expect(H.signed).toBe(0);
    expect(H.r2).toBe(0);
  });

  it("the seal token is passed only when it matches /^[a-z_:]{1,64}$/; anything else (case, digits, spaces, long, non-string) is null", async () => {
    const out: Array<unknown> = [];
    for (const st of ["skipped:final_no_session", "no_session", "Upper", "has space", "with-dash", "x1", "a".repeat(65), 42, null, ""]) {
      setRows([crow(UID, { r2_key: null, sealed: st })]);
      resetCatalogCacheForTests();
      out.push((await call({ action: "clip_audio_url", consult_uid: UID })).sealed);
    }
    expect(out).toEqual(["skipped:final_no_session", "no_session", null, null, null, null, null, null, null, null]);
    expect(sealReasonOf(crow(UID, { sealed: "a".repeat(64) }))).toBe("a".repeat(64));
  });

  it("FIX2: the seal reason is read from row.sealed, then row.clip.sealed; each source alone works", async () => {
    const seal = async (row: Row) => { setRows([row]); resetCatalogCacheForTests(); return (await call({ action: "clip_audio_url", consult_uid: UID })).sealed; };
    expect(await seal({ ...crow(UID, { r2_key: null }), sealed: "skipped:final_no_session" })).toBe("skipped:final_no_session");
    expect(await seal(crow(UID, { r2_key: null, sealed: "no_session" }))).toBe("no_session");
    expect(await seal(crow(UID, { r2_key: null }))).toBeNull();
  });

  it("FIX2: clip.r2_status is a storage status, not a seal reason: it is never read", async () => {
    const seal = async (row: Row) => { setRows([row]); resetCatalogCacheForTests(); return (await call({ action: "clip_audio_chunk", consult_uid: UID })).sealed; };
    expect(await seal(crow(UID, { r2_key: null, r2_status: "skipped:final_no_session" }))).toBeNull();
    expect(await seal(crow(UID, { r2_key: null, r2_status: "mirrored" }))).toBeNull();
    expect(await seal(crow(UID, { r2_key: null, r2_status: "from_status", sealed: "from_clip" }))).toBe("from_clip");
    expect(sealReasonOf({ clip: { r2_status: "skipped:final_no_session" } })).toBeNull();
  });

  it("FIX2: the order is row.sealed > clip.sealed, and a source that does not match the filter (or is not a string) does not block the next", async () => {
    const seal = (row: Row) => { setRows([row]); resetCatalogCacheForTests(); return call({ action: "clip_audio_chunk", consult_uid: UID }).then((o) => o.sealed); };
    expect(await seal({ ...crow(UID, { r2_key: null, sealed: "from_clip" }), sealed: "from_row" })).toBe("from_row");
    expect(await seal(crow(UID, { r2_key: null, sealed: "from_clip" }))).toBe("from_clip");
    expect(await seal({ ...crow(UID, { r2_key: null, sealed: "from_clip" }), sealed: "Bad Value" })).toBe("from_clip");
    expect(await seal({ ...crow(UID, { r2_key: null, sealed: "from_clip" }), sealed: true })).toBe("from_clip");
    expect(await seal({ ...crow(UID, { r2_key: null, sealed: "from_clip" }), sealed: "x".repeat(65) })).toBe("from_clip");
    expect(await seal({ ...crow(UID, { r2_key: null, sealed: 7 }), sealed: "no-dash" })).toBeNull();
    expect(await seal({ ...crow(UID, { r2_key: null, sealed: "Bad" }), sealed: false })).toBeNull();
    expect(sealReasonOf({ sealed: "a", clip: { sealed: "b" } })).toBe("a");
  });

  it("the answer carries no key and no text: only ok, error and sealed", async () => {
    setRows([crow(UID, { r2_key: null, sealed: "skipped:final_no_session", signature_sha256: "c".repeat(64) })]);
    const o = await call({ action: "clip_audio_url", consult_uid: UID });
    expect(Object.keys(o).sort()).toEqual(["error", "ok", "sealed"]);
  });

  it("bad_clip_key is unchanged for a key that is present but fails the allowlist or the row binding (wrong date, wrong uid, traversal, non-string)", async () => {
    for (const key of [`consult-clips/2026-10-06/opd-a/${UID}/consult.flac`, GOOD_KEY("OTHERUID0001"), `consult-clips/${DAY}/opd-a/../${UID}/consult.flac`, "reb/x/consult.flac", 5, ["x"]]) {
      setRows([crow(UID, { r2_key: key, r2_status: "mirrored" })]);
      resetCatalogCacheForTests();
      expect(await call({ action: "clip_audio_url", consult_uid: UID }), String(key)).toEqual({ ok: false, error: "bad_clip_key" });
      expect(await call({ action: "clip_audio_chunk", consult_uid: UID }), String(key)).toEqual({ ok: false, error: "bad_clip_key" });
    }
    expect(clipAbsent(crow(UID, { r2_key: 5 }))).toBe(false);
  });

  it("a good key still presigns (no regression), and a missing consult is still not_found", async () => {
    setRows([crow(UID, { r2_key: GOOD_KEY(), r2_status: "mirrored", bytes: 10, minutes: 0.1 })]);
    expect(await call({ action: "clip_audio_url", consult_uid: UID })).toMatchObject({ ok: true, url: expect.stringContaining("signed.example") });
    expect(await call({ action: "clip_audio_url", consult_uid: "NOSUCHUID1" })).toEqual({ ok: false, error: "not_found" });
  });

  it("help text names no_clip", () => {
    expect(JSON.stringify(catalogTool)).toContain("no_clip");
  });
});

describe("Part B: explorer_link", () => {
  const BASE = "https://claude.ai/artifact/explorer_01";
  const link = (args: Row, ctx: ToolContext = ADMIN_CTX) => call({ action: "explorer_link", ...args }, ctx);

  it("each form returns {ok, url, kind} on the configured base", async () => {
    expect(await link({ consult_uid: UID })).toEqual({ ok: true, url: `${BASE}#c-${UID}`, kind: "consult" });
    expect(await link({ doctor_uid: "doc00001", date: "2026-10-12" })).toEqual({ ok: true, url: `${BASE}#d-646f633030303031~2026-10-12`, kind: "doctor_day" });
    expect(await link({ individual_uid: "IND000001" })).toEqual({ ok: true, url: `${BASE}#p-494e44303030303031`, kind: "patient" });
  });

  it("the date is clamped to 2026-09-09 and must be a real date", async () => {
    expect(await link({ doctor_uid: "doc00001", date: "2026-01-01" })).toMatchObject({ ok: true, url: `${BASE}#d-646f633030303031~2026-09-09` });
    expect(await link({ doctor_uid: "doc00001", date: "2026-09-09" })).toMatchObject({ url: `${BASE}#d-646f633030303031~2026-09-09` });
    for (const d of ["2026-02-30", "2026-13-01", "10/12/2026", "2026-10-1", "yesterday"]) expect(await link({ doctor_uid: "doc00001", date: d }), d).toMatchObject({ ok: false, error: "bad_args" });
  });

  it("bad combinations and bad ids are bad_args", async () => {
    const bad: Row[] = [
      {}, { consult_uid: UID, doctor_uid: "doc00001", date: "2026-10-12" }, { consult_uid: UID, individual_uid: "IND000001" }, { doctor_uid: "doc00001" }, { date: "2026-10-12" },
      { doctor_uid: "doc00001", date: "2026-10-12", individual_uid: "IND000001" }, { consult_uid: "short" }, { consult_uid: "has space1" }, { consult_uid: "a/b/c/d/e" },
      { doctor_uid: "doc 1", date: "2026-10-12" }, { doctor_uid: "d#oc&1", date: "2026-10-12" }, { consult_uid: UID, limit: 5 }, { consult_uid: UID, include_text: true }, { consult_uid: UID, from: "2026-10-01" },
    ];
    for (const a of bad) expect(await link(a), JSON.stringify(a)).toMatchObject({ ok: false, error: "bad_args" });
  });

  it("FIX2: the WHOLE action is admin-only: every form answers admin_required to a read caller, to admin scope without an admin: actor, and to an admin: actor without the scope", async () => {
    const callers: ToolContext[] = [
      READ_CTX,
      { actor: "mcp:someone", origin: "https://example.test", scopes: new Set<McpScope>(["read", "admin"]) },
      { actor: "mcp:admin:tester", origin: "https://example.test", scopes: new Set<McpScope>(["read"]) },
    ];
    const forms: Row[] = [{ consult_uid: UID }, { doctor_uid: "doc00001", date: "2026-10-12" }, { individual_uid: "IND000001" }];
    for (const ctx of callers) for (const f of forms) expect(await link(f, ctx), `${ctx.actor} ${JSON.stringify(f)}`).toEqual({ ok: false, error: "admin_required" });
    for (const f of forms) expect(await link(f, ADMIN_CTX)).toMatchObject({ ok: true });
  });

  it("FIX2: bad_args is answered before admin_required, and admin_required before the base is looked at (a non-admin learns nothing about the config)", async () => {
    expect(await link({}, READ_CTX)).toMatchObject({ ok: false, error: "bad_args" });
    expect(await link({ consult_uid: "short" }, READ_CTX)).toMatchObject({ error: "bad_args" });
    expect(await link({ consult_uid: UID, limit: 5 }, READ_CTX)).toMatchObject({ error: "bad_args" });
    vi.stubEnv("SCRIBE_EXPLORER_URL", "");
    expect(await link({ consult_uid: UID }, READ_CTX)).toEqual({ ok: false, error: "admin_required" });
    expect(await link({ consult_uid: UID })).toEqual({ ok: false, error: "explorer_url_not_configured" });
  });

  it("CATALOG-15: bare anchors with exact strings; hex is lowercase and a round trip gives the id back; no percent-encoding or key=value is ever emitted", async () => {
    const o = await link({ doctor_uid: "doc:1@x.y", date: "2026-10-05" });
    expect(o.url).toBe(`${BASE}#d-646f633a3140782e79~2026-10-05`);
    expect(String((await link({ consult_uid: UID })).url)).toBe(`${BASE}#c-${UID}`);
    expect(String((await link({ individual_uid: "IND-00_01" })).url)).toBe(`${BASE}#p-494e442d30305f3031`);
    for (const id of ["doc:1@x.y", "DOC.Zz_9-@:", "Dr:ABC-x_1.2"]) {
      const u = String((await link({ doctor_uid: id, date: "2026-10-05" })).url);
      const m = /#d-([0-9a-f]+)~(\d{4}-\d{2}-\d{2})$/.exec(u);
      expect(m, id).not.toBeNull();
      expect(m![1]).toBe(m![1]!.toLowerCase());
      expect(Buffer.from(m![1]!, "hex").toString("utf8")).toBe(id);
      expect(u).not.toMatch(/[%=&]/);
    }
    const p = /#p-([0-9a-f]+)$/.exec(String((await link({ individual_uid: "IND-00_01" })).url))!;
    expect(Buffer.from(p[1]!, "hex").toString("utf8")).toBe("IND-00_01");
  });

  it("CATALOG-15: every emitted fragment matches ^[A-Za-z0-9._~-]+$ for every form: a fuzz over the allowed id alphabets (and the refused characters never reach a link)", async () => {
    const ANCHOR = /^[A-Za-z0-9._~-]+$/;
    const UIDA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
    const DOCA = UIDA + ".:@";
    let n = 0, seed = 12345;
    const rnd = (m: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % m; };
    const pick = (alpha: string, len: number) => Array.from({ length: len }, () => alpha[rnd(alpha.length)]).join("");
    for (let i = 0; i < 200; i++) {
      const uid = pick(UIDA, 6 + rnd(59));
      const doc = pick(DOCA, 1 + rnd(64));
      const forms: Row[] = [{ consult_uid: uid }, { doctor_uid: doc, date: `2026-${String(9 + rnd(4)).padStart(2, "0")}-${String(1 + rnd(28)).padStart(2, "0")}` }, { individual_uid: uid }];
      for (const f of forms) {
        const o = await link(f);
        if (o.ok !== true) { expect(o.error, JSON.stringify(f)).toBe("bad_args"); continue; } // a month 12 date < today is fine; bad dates are refused
        n += 1;
        const frag = String(o.url).split("#")[1]!;
        expect(frag, JSON.stringify(f)).toMatch(ANCHOR);
        expect(String(o.url).split("#")).toHaveLength(2);
      }
    }
    expect(n).toBeGreaterThan(500);
    // every printable ASCII character in each id slot: either refused or an anchor-safe fragment
    for (let c = 32; c < 127; c++) {
      const ch = String.fromCharCode(c);
      for (const f of [{ consult_uid: `ab${ch}cdef` }, { doctor_uid: `ab${ch}cd`, date: "2026-10-05" }, { individual_uid: `ab${ch}cdef` }, { doctor_uid: "doc00001", date: `2026-10-0${ch}` }] as Row[]) {
        const o = await link(f);
        if (o.ok === true) expect(String(o.url).split("#")[1], JSON.stringify(f)).toMatch(ANCHOR);
        else expect(o.error).toBe("bad_args");
      }
    }
  });

  it("the base must be https://claude.ai/...: missing, other hosts, http, fragments, queries, a bare host and an over-long path are explorer_url_not_configured", async () => {
    const bad = ["", "http://claude.ai/artifact/x", "https://evil.example/artifact/x", "https://claude.ai.evil.example/x", "https://claude.ai/", "https://claude.ai", "https://claude.ai/a?b=c", "https://claude.ai/a#x", "https://claude.ai/a b", `https://claude.ai/${"a".repeat(201)}`, "https://claude.ai%40evil.example/x", "https://claude.ai:444/x"];
    for (const v of bad) {
      vi.stubEnv("SCRIBE_EXPLORER_URL", v);
      expect(await link({ consult_uid: UID }), v).toEqual({ ok: false, error: "explorer_url_not_configured" });
    }
    vi.unstubAllEnvs();
    delete process.env.SCRIBE_EXPLORER_URL;
    expect(await link({ consult_uid: UID })).toEqual({ ok: false, error: "explorer_url_not_configured" });
    vi.stubEnv("SCRIBE_EXPLORER_URL", `https://claude.ai/${"a".repeat(200)}`);
    expect(await link({ consult_uid: UID })).toMatchObject({ ok: true });
  });

  it("no sql, no R2, no catalog (lab store) read, for any form or any refusal", async () => {
    setRows([crow(UID, { r2_key: GOOD_KEY() })]);
    await link({ consult_uid: UID });
    await link({ doctor_uid: "doc00001", date: "2026-10-12" });
    await link({ individual_uid: "IND000001" });
    await link({ individual_uid: "IND000001" }, READ_CTX);
    await link({});
    vi.stubEnv("SCRIBE_EXPLORER_URL", "");
    await link({ consult_uid: UID });
    expect(H.sql).toBe(0);
    expect(H.r2).toBe(0);
    expect(H.signed).toBe(0);
    expect(labGets).toBe(0);
  });

  it("it does not check the id exists", async () => {
    expect(await link({ consult_uid: "NOSUCHUID1" })).toMatchObject({ ok: true, kind: "consult" });
  });

  it("the action and the date argument are in the schema and the help text; the tool stays read scope (the explorer_link action checks admin itself)", () => {
    const props = (catalogTool.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.action!.enum).toContain("explorer_link");
    expect(props.date).toBeDefined();
    expect(catalogTool.scope).toBe("read");
    expect(JSON.stringify(catalogTool)).toContain("action=explorer_link");
  });

  it("an unknown action still lists the allowed ones, now including explorer_link", async () => {
    expect(await call({ action: "nope" })).toMatchObject({ ok: false, error: "unknown_action", allowed: expect.arrayContaining(["explorer_link"]) });
  });
});
