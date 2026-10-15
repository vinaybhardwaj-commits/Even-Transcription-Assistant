/**
 * encounter-catalog.test.ts — migration 0168, the ingest validator, the HMAC, the search parser and the two routes (database mocked). Ids are synthetic.
 * The real-Postgres half (field-level upsert, filters, paging, rollback) is tests/unit/encounter-catalog-pg.test.ts.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { NextRequest } from "next/server";

const H = vi.hoisted(() => ({ calls: [] as Array<[string, unknown[]]>, result: [] as Array<Record<string, unknown>>, fail: null as null | { code: string }, script: null as null | (() => Array<Record<string, unknown>>) }));
vi.mock("@/lib/db", () => ({
  sql: async (text: string, params: unknown[]) => {
    H.calls.push([text, params]);
    if (H.fail) throw Object.assign(new Error("db"), H.fail);
    return H.script ? H.script() : H.result;
  },
}));

import { checkCatalogHmac, signCatalog, CATALOG_SIG_HEADER, CATALOG_TS_HEADER } from "@/lib/encounter-catalog/auth";
import { ConcurrentIngestError, hasTextKey, ingestCatalogRows, validateBatch, MAX_ROWS } from "@/lib/encounter-catalog/store";
import { buildSearch, encodeCursor, parseSearch } from "@/lib/encounter-catalog/search";
import { INGEST_SQL, COLUMNS } from "@/lib/encounter-catalog/ingest-sql";
import { makeFakeClinician } from "../support/fake-identity";
import { POST as ingest } from "@/app/api/encounter-catalog/ingest/route";
import { GET as search } from "@/app/api/encounter-catalog/search/route";

const SECRET = "synthetic-secret";
const DOC_NAME = makeFakeClinician(1).full_name;
const PAT_NAME = "Fake Patient 0001";
const TOO_LONG = "x".repeat(201);
const WITH_NEWLINE = "a" + String.fromCharCode(10) + "b";
const NOW = 1_760_000_000;
const row = (over: Record<string, unknown> = {}) => ({
  consult_uid: "synth-cat-1", ist_date: "2026-10-12", doctor_uid: "DOC12345", room_id: "room_abc", t_open: 1_760_000_000_000, t_close: 1_760_000_600_000, source: "cutter",
  clip: { r2_key: "consult-clips/x/consult.flac", sha256: "ab".repeat(32), sha256_of: "cutter_signature", minutes: 10 },
  layers: { stt: { r2_key: "reb/2026-10-12/room_abc/_consults/synth-cat-1/tracks/stt.sarvam-saaras-v3__v1__abcd1234.json", status: "ok" }, parts: null },
  freescript: { artifact_id: "art-1", state: "written" }, stages: { stt: { state: "ok", reason: null } }, first_gap: "freescript:none_yet",
  allowance: { earned_min: 22, spent_min: 5 }, catalog_version: 1, generated_at: "2026-10-14T06:00:00Z", ...over,
});
const signed = (body: string, ts = NOW) => ({ [CATALOG_TS_HEADER]: String(ts), [CATALOG_SIG_HEADER]: signCatalog(body, SECRET, ts) });
const post = (body: string, headers: Record<string, string>) => new NextRequest("https://t.example/api/encounter-catalog/ingest", { method: "POST", body, headers });
const get = (qs: string, token?: string) =>
  new NextRequest("https://t.example/api/encounter-catalog/search" + qs, { headers: token ? { authorization: "Bearer " + token } : {} });

beforeEach(() => {
  H.calls.length = 0; H.result = []; H.fail = null; H.script = null;
  delete process.env.ENCOUNTER_CATALOG_INGEST_SECRET; delete process.env.ADMIN_TOKEN; delete process.env.REB_INDEX_READ_TOKEN;
});

describe("migration 0168", () => {
  const up = readFileSync("db/migrations/0168_encounter_catalog.sql", "utf8");
  it("is the only 0168, follows 0167, and the rollback is not in the migrations dir", () => {
    const files = readdirSync("db/migrations").filter((f) => /^\d{4}_.*\.sql$/.test(f));
    expect(files.filter((f) => f.startsWith("0168_"))).toEqual(["0168_encounter_catalog.sql"]);
    expect(files.some((f) => f.startsWith("0167_"))).toBe(true);
    expect(existsSync("db/rollbacks/0168_encounter_catalog.down.sql")).toBe(true);
    expect(readdirSync("db/migrations").some((f) => /down/i.test(f))).toBe(false);
    expect(readFileSync("db/rollbacks/0168_encounter_catalog.down.sql", "utf8")).toMatch(/DELETE FROM schema_migrations WHERE version = 168/);
  });
  it("is additive, records itself, and has no text column", () => {
    const ddl = up.replace(/--.*$/gm, "");
    expect(ddl).not.toMatch(/\bALTER TABLE\b|\bDROP\b|\bTRUNCATE\b|\bDELETE\b|\bUPDATE\b/i);
    expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS encounter_catalog/);
    expect(ddl).toMatch(/INSERT INTO schema_migrations \(version, name\)\s+VALUES \(168, '0168_encounter_catalog'\)/);
    const block = /CREATE TABLE IF NOT EXISTS encounter_catalog \(([\s\S]*?)\n\);/.exec(ddl)![1];
    const cols = block.split("\n").map((l) => /^\s{2}([a-z_0-9]+)\s+(text|date|timestamptz|jsonb|integer)\b/.exec(l)?.[1]).filter(Boolean);
    expect(cols).toEqual(["consult_uid", "ist_date", "doctor_uid", "room_id", "t_open", "t_close", "source", "clip", "layers", "freescript", "stages", "first_gap", "allowance", "prescription", "doctor_name", "patient_name", "individual_uid", "prescription_uid", "presc_state", "catalog_version", "generated_at", "updated_at"]);
    expect(cols.some((c) => /^(text|transcript|note|content|segments?)$|^text_/.test(c as string))).toBe(false);
    expect(ddl).toMatch(/\(doctor_uid, ist_date\)/);
    expect(ddl).toMatch(/\(room_id, ist_date\)/);
    expect(ddl).toMatch(/WHERE prescription IS NOT NULL/);
    expect(ddl).toMatch(/\(prescription_uid\) WHERE prescription_uid IS NOT NULL/);
    expect(ddl).toMatch(/\(individual_uid\) WHERE individual_uid IS NOT NULL/);
  });
});

describe("HMAC", () => {
  const body = JSON.stringify({ rows: [row()] });
  const h = (o: Record<string, string>) => new Headers(o);
  it("fails closed when the secret is unset or blank", () => {
    expect(checkCatalogHmac(h(signed(body)), body, {}, NOW)).toEqual({ status: 503, error: "not_configured" });
    expect(checkCatalogHmac(h(signed(body)), body, { ENCOUNTER_CATALOG_INGEST_SECRET: "  " }, NOW)).toEqual({ status: 503, error: "not_configured" });
  });
  it("accepts a good signature and refuses a tampered body, a wrong secret, a missing or malformed header and a stale or future timestamp", () => {
    const env = { ENCOUNTER_CATALOG_INGEST_SECRET: SECRET };
    expect(checkCatalogHmac(h(signed(body)), body, env, NOW)).toBeNull();
    expect(checkCatalogHmac(h(signed(body)), body + " ", env, NOW)).toEqual({ status: 401, error: "unauthorized" });
    expect(checkCatalogHmac(h(signed(body)), body, { ENCOUNTER_CATALOG_INGEST_SECRET: "other" }, NOW)).toEqual({ status: 401, error: "unauthorized" });
    expect(checkCatalogHmac(h({}), body, env, NOW)).toEqual({ status: 401, error: "unauthorized" });
    expect(checkCatalogHmac(h({ ...signed(body), [CATALOG_SIG_HEADER]: "zz" }), body, env, NOW)).toEqual({ status: 401, error: "unauthorized" });
    expect(checkCatalogHmac(h(signed(body, NOW - 601)), body, env, NOW)).toEqual({ status: 401, error: "stale" });
    expect(checkCatalogHmac(h(signed(body, NOW + 601)), body, env, NOW)).toEqual({ status: 401, error: "stale" });
    expect(checkCatalogHmac(h(signed(body, NOW - 600)), body, env, NOW)).toBeNull();
  });
});

describe("validateBatch", () => {
  it("accepts a full row, a partial row (C3's {consult_uid, prescription}) and a row with nulls", () => {
    expect(validateBatch({ rows: [row()] }).ok).toBe(true);
    expect(validateBatch({ rows: [{ consult_uid: "synth-cat-2", prescription: { prescription_uid: "rx-1", presc_state: "final" } }] }).ok).toBe(true);
    expect(validateBatch({ rows: [row({ doctor_uid: null, clip: null, t_open: null, first_gap: null })] }).ok).toBe(true);
    expect(validateBatch({ rows: [row({ t_open: "2026-10-12T04:00:00Z" })] }).ok).toBe(true);
  });
  it("accepts the C3 identity fields (names, individual / prescription uid, presc_state) as a field-level row and never echoes a value", () => {
    const c3 = { consult_uid: "synth-cat-2", doctor_name: DOC_NAME, patient_name: PAT_NAME, individual_uid: "ind_fake0001", prescription_uid: "rx_fake0001", presc_state: "final" };
    expect(validateBatch({ rows: [c3] }).ok).toBe(true);
    expect(validateBatch({ rows: [{ ...c3, patient_name: null, prescription_uid: null }] }).ok).toBe(true);
    for (const [bad, e] of [[{ patient_name: "" }, "bad_patient_name"], [{ patient_name: 5 }, "bad_patient_name"], [{ doctor_name: TOO_LONG }, "bad_doctor_name"], [{ doctor_name: WITH_NEWLINE }, "bad_doctor_name"],
                            [{ individual_uid: "bad uid" }, "bad_individual_uid"], [{ prescription_uid: "x/../y" }, "bad_prescription_uid"], [{ presc_state: "has spaces" }, "bad_presc_state"]] as const) {
      const r = validateBatch({ rows: [{ ...c3, ...bad }] });
      expect(r).toEqual({ ok: false, error: e });
      expect(JSON.stringify(r)).not.toContain(PAT_NAME);
    }
    expect(validateBatch({ rows: [{ ...c3, patient_note: "x" }] })).toEqual({ ok: false, error: "unknown_field" });
  });
  it("refuses a text-like key at any depth, in any case, in any field", () => {
    for (const bad of [{ text: "x" }, { transcript: "x" }, { note: "x" }, { content: "x" }, { Transcript: "x" }, { text_en: "x" }, { transcript_en: "x" }, { notes: "x" }, { Contents: "x" }, { texts: "x" }, { note_x: "x" }]) {
      expect(validateBatch({ rows: [row(bad)] })).toEqual({ ok: false, error: "text_key" });
    }
    expect(validateBatch({ rows: [row({ layers: { stt: { r2_key: "k", status: "ok", nested: [{ deep: { note: "x" } }] } } })] })).toEqual({ ok: false, error: "text_key" });
    expect(validateBatch({ rows: [{ consult_uid: "synth-cat-2", prescription: { items: [{ Content: "x" }] } }] })).toEqual({ ok: false, error: "text_key" });
    expect(hasTextKey({ a: [{ b: { TEXT_en: 1 } }] })).toBe(true);
    expect(hasTextKey({ a: { context: 1, textual: 2, sha256: 3, notebook: 4, contention: 5 } })).toBe(false);
    for (const k of ["transcript_en", "transcripts", "notes", "contents", "text_native", "Note_1"]) expect(hasTextKey({ x: { [k]: 1 } }), k).toBe(true);
  });
  it("refuses unknown fields, bad shapes, duplicates, an empty and an oversize batch", () => {
    const err = (r: unknown) => (validateBatch(r) as { error?: string }).error;
    expect(err({ rows: [row({ extra: 1 })] })).toBe("unknown_field");
    expect(err({})).toBe("body_not_rows");
    expect(err({ rows: [] })).toBe("empty_batch");
    expect(err({ rows: Array.from({ length: MAX_ROWS + 1 }, (_, i) => row({ consult_uid: "synth-" + i + "xx" })) })).toBe("batch_too_large");
    expect(validateBatch({ rows: Array.from({ length: MAX_ROWS }, (_, i) => row({ consult_uid: "synth-" + i + "xx" })) }).ok).toBe(true);
    expect(err({ rows: [row(), row()] })).toBe("duplicate_consult_uid");
    expect(err({ rows: ["x"] })).toBe("row_not_object");
    expect(err({ rows: [row({ consult_uid: "ab" })] })).toBe("bad_consult_uid");
    expect(err({ rows: [row({ consult_uid: "bad uid/../x" })] })).toBe("bad_consult_uid");
    expect(err({ rows: [row({ ist_date: "2026-13-45" })] })).toBe("bad_date");
    expect(err({ rows: [row({ ist_date: "12 Oct" })] })).toBe("bad_date");
    expect(err({ rows: [row({ ist_date: "2026-02-30" })] })).toBe("bad_date");
    expect(err({ rows: [row({ ist_date: "2026-02-28" })] })).toBe("before_floor");              // a real date, but before the catalog starts
    expect(err({ rows: [row({ ist_date: "2026-09-30" })] })).toBeUndefined();
    expect(err({ rows: [row({ source: "other" })] })).toBe("bad_source");
    expect(err({ rows: [row({ t_open: -5 })] })).toBe("bad_time");
    expect(err({ rows: [row({ t_open: 1.5 })] })).toBe("bad_time");
    expect(err({ rows: [row({ first_gap: "has spaces and words" })] })).toBe("bad_first_gap");
    expect(err({ rows: [row({ catalog_version: 0 })] })).toBe("bad_version");
    expect(err({ rows: [row({ clip: [1] })] })).toBe("bad_clip");
    expect(err({ rows: [row({ stages: "x" })] })).toBe("bad_stages");
    expect(err({ rows: [row({ layers: { a: "x".repeat(70_000) } })] })).toBe("layers_too_large");
    expect(err({ rows: [row({ generated_at: "yesterday" })] })).toBe("bad_generated_at");
  });
});

describe("ingest SQL", () => {
  it("is field-level: every column is guarded by jsonb_exists, the id is the only unconditional one, and no text column is named", () => {
    for (const c of COLUMNS) expect(INGEST_SQL).toContain(`CASE WHEN jsonb_exists(p.j, '${c.name}') THEN`);
    expect(COLUMNS.map((c) => c.name)).toEqual(["ist_date", "doctor_uid", "room_id", "t_open", "t_close", "source", "clip", "layers", "freescript", "stages", "first_gap", "allowance", "prescription", "jev", "clef_affect", "presence", "doctor_name", "patient_name", "individual_uid", "prescription_uid", "presc_state", "catalog_version", "generated_at"]);
    expect(INGEST_SQL).toMatch(/\$1::jsonb/);
    expect(INGEST_SQL).not.toMatch(/\$2/);
    expect(INGEST_SQL).toMatch(/ON CONFLICT \(consult_uid\) DO NOTHING/);
    expect(INGEST_SQL).not.toMatch(/\b(transcript|note|content)\b/i);
  });
});

describe("search parameters", () => {
  const q = (s: string) => parseSearch(new URLSearchParams(s));
  it("parses the filters and defaults", () => {
    expect(q("")).toEqual({ ok: true, q: { limit: 100 } });
    const r = q("doctor_uid=DOC12345&from=2026-10-01&to=2026-10-12&room=room_abc&has_prescription=true&limit=50") as { ok: true; q: Record<string, unknown> };
    expect(r.q).toEqual({ doctor_uid: "DOC12345", from: "2026-10-01", to: "2026-10-12", room: "room_abc", has_prescription: true, limit: 50 });
    expect((q("has_prescription=false") as { q: { has_prescription: boolean } }).q.has_prescription).toBe(false);
  });
  it("refuses bad values with a code and no echo", () => {
    for (const [s, e] of [["from=nope", "bad_from"], ["to=2026-02-31", "bad_to"], ["has_prescription=maybe", "bad_has_prescription"], ["limit=0", "bad_limit"], ["limit=501", "bad_limit"], ["limit=x", "bad_limit"],
                          ["cursor=@@@", "bad_cursor"], ["doctor_uid=a b;drop", "bad_doctor_uid"], ["room=a%27%3B--", "bad_room"]] as const)
      expect(q(s)).toEqual({ ok: false, error: e });
  });
  it("builds a parameterised query: every value is a bound parameter, each $n used once, in order, and no value is in the text", () => {
    const cursor = encodeCursor("2026-10-10", "synth-cat-9");
    const p = q(`doctor_uid=DOC12345&from=2026-10-01&to=2026-10-12&room=room_abc&has_prescription=true&cursor=${cursor}&limit=20`) as { ok: true; q: never };
    const [text, params] = buildSearch(p.q);
    expect(params).toEqual(["DOC12345", "2026-10-01", "2026-10-12", "room_abc", "2026-10-10", "synth-cat-9", 21]);
    expect([...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const v of ["DOC12345", "room_abc", "synth-cat-9"]) expect(text).not.toContain(v);
    expect(text).toMatch(/\(prescription IS NOT NULL OR prescription_uid IS NOT NULL\)/);
    expect(text).toMatch(/ORDER BY COALESCE\(ist_date, DATE '0001-01-01'\) DESC, consult_uid DESC/);
    expect(buildSearch({ limit: 5, has_prescription: false })[0]).toMatch(/\(prescription IS NULL AND prescription_uid IS NULL\)/);
    const [t2, p2] = buildSearch({ limit: 5, prescription_uid: "rx_fake0001", individual_uid: "ind_fake0001" });
    expect(p2).toEqual(["rx_fake0001", "ind_fake0001", 6]);
    expect(t2).toMatch(/prescription_uid = \$1 AND individual_uid = \$2/);
  });
  it("selects the identity columns and the prescription for every row (the route is admin-only)", () => {
    for (const c of ["doctor_name", "patient_name", "individual_uid", "prescription_uid", "presc_state", "prescription"]) expect(buildSearch({ limit: 5 })[0]).toMatch(new RegExp(`\\b${c}\\b`));
  });
});

describe("23D follow-up G1-G3", () => {
  it("G1: a token query key in ANY letter case, or percent-encoded, is refused even with a valid bearer", async () => {
    process.env.ADMIN_TOKEN = "adm";
    for (const qs of ["?TOKEN=adm", "?Token=adm", "?tOkEn=x", "?doctor_uid=DOC12345&TOKEN=", "?%74oken=adm", "?TOKEN"]) {
      expect((await search(get(qs, "adm"))).status, qs).toBe(401);
      expect((await search(get(qs))).status, qs).toBe(401);
    }
    expect(H.calls).toEqual([]);
    expect((await search(get("?doctor_uid=DOC12345&tokens=1&mytoken=2", "adm"))).status).toBe(200);          // other keys that merely contain the word are not the token key
  });
  it("G2: \"generated_at\": null is refused (it would clear the column and let an older replay overwrite); omitting the key is fine", async () => {
    expect(validateBatch({ rows: [row({ generated_at: null })] })).toEqual({ ok: false, error: "bad_generated_at" });
    const { generated_at: _drop, ...noGen } = row();
    expect(validateBatch({ rows: [noGen] }).ok).toBe(true);
    process.env.ENCOUNTER_CATALOG_INGEST_SECRET = SECRET;
    const b = JSON.stringify({ rows: [row({ generated_at: null })] });
    const res = await ingest(post(b, signed(b, Math.floor(Date.now() / 1000))));
    expect([res.status, await res.json(), H.calls.length]).toEqual([400, { ok: false, error: "bad_generated_at" }, 0]);
  });
  it("G3: generated_at (and t_open / t_close as strings) must be a strict ISO-8601 instant: malformed values are a 400, never a 503 batch failure", async () => {
    const bad = ["2026-10-14", "yesterday", "2026-10-14 06:00:00", "2026-10-14T06:00:00", "2026-13-01T00:00:00Z", "2026-10-14T25:00:00Z", "2026-02-30T00:00:00Z", "2026-10-14T06:00:60Z", "Wed, 14 Oct 2026 06:00:00 GMT",
                 "2026-10-14T06:00:00+0530", "2026-10-14T06:00Z", "1760000000", "", " 2026-10-14T06:00:00Z", "2026-10-14T06:00:00Z\n", 5, true, {}, []];
    for (const v of bad) {
      expect((validateBatch({ rows: [row({ generated_at: v })] }) as { error?: string }).error, JSON.stringify(v)).toBe("bad_generated_at");
      if (typeof v === "string") expect((validateBatch({ rows: [row({ t_open: v })] }) as { error?: string }).error, "t_open " + JSON.stringify(v)).toBe("bad_time");
    }
    for (const v of ["2026-10-14T06:00:00Z", "2026-10-14T06:00:00.123Z", "2026-10-14T06:00:00.123456789Z", "2026-10-14T11:30:00+05:30", "2026-10-14T06:00:00-00:00", "2024-02-29T00:00:00Z"]) {
      expect(validateBatch({ rows: [row({ generated_at: v })] }).ok, v).toBe(true);
    }
    process.env.ENCOUNTER_CATALOG_INGEST_SECRET = SECRET;
    const b = JSON.stringify({ rows: [row({ generated_at: "2026-02-30T00:00:00Z" })] });
    const res = await ingest(post(b, signed(b, Math.floor(Date.now() / 1000))));
    expect([res.status, await res.json(), H.calls.length]).toEqual([400, { ok: false, error: "bad_generated_at" }, 0]);
  });
});

describe("fable gate conditions (C1 bearer-only, C2 date floor, C3 stale guard, C4 README)", () => {
  it("C1: search is BEARER ONLY: a ?token= parameter is refused even with a valid bearer, and as the only credential", async () => {
    process.env.ADMIN_TOKEN = "adm";
    expect((await search(get("?token=adm"))).status).toBe(401);                       // the old requireAdmin would have accepted this
    expect((await search(get("?token=adm", "adm"))).status).toBe(401);                // a valid bearer does not rescue a request that carries the parameter
    expect((await search(get("?token=", "adm"))).status).toBe(401);
    expect((await search(get("?doctor_uid=DOC12345&token=wrong", "adm"))).status).toBe(401);
    expect(H.calls).toEqual([]);
    expect((await search(get("", "adm"))).status).toBe(200);
    const mixed = new NextRequest("https://t.example/api/encounter-catalog/search", { headers: { authorization: "bEaReR adm" } });
    expect((await search(mixed)).status).toBe(200);                                   // the scheme is case-insensitive, the token is not
    expect((await search(get("", "ADM"))).status).toBe(401);
    delete process.env.ADMIN_TOKEN;
    expect((await search(get("", "adm"))).status).toBe(401);
    const src = readFileSync("app/api/encounter-catalog/search/route.ts", "utf8");
    expect(src).toContain("requireAdminBearer");
    expect(src).not.toMatch(/requireAdmin\(/);                                        // the ?token= accepting helper is not used by this route
  });
  it("C2: the validator refuses ist_date before 2026-09-09 (a code, 400), and the floor day itself is fine", async () => {
    const err = (d: string) => (validateBatch({ rows: [row({ ist_date: d })] }) as { error?: string }).error;
    expect(err("2026-09-08")).toBe("before_floor");
    expect(err("2026-08-20")).toBe("before_floor");
    expect(err("2025-12-31")).toBe("before_floor");
    expect(err("2026-09-09")).toBeUndefined();
    expect(err("2026-09-10")).toBeUndefined();
    expect(err("2026-02-30")).toBe("bad_date");
    expect(validateBatch({ rows: [{ consult_uid: "synth-cat-2", prescription_uid: "rx_fake0001" }] }).ok).toBe(true);        // a row without ist_date (C3's partial row) has nothing to floor
    expect(validateBatch({ rows: [row({ ist_date: null })] }).ok).toBe(true);
    process.env.ENCOUNTER_CATALOG_INGEST_SECRET = SECRET;
    const b = JSON.stringify({ rows: [row({ ist_date: "2026-09-01" })] });
    const res = await ingest(post(b, signed(b, Math.floor(Date.now() / 1000))));
    expect([res.status, await res.json(), H.calls.length]).toEqual([400, { ok: false, error: "before_floor" }, 0]);
  });
  it("C3: the UPDATE carries the stale guard in its own WHERE, a stale count comes back, and stale rows count as accounted (no rerun, no 409)", async () => {
    expect(INGEST_SQL).toMatch(/AND NOT \(NULLIF\(p\.j->>'generated_at', ''\) IS NOT NULL AND e\.generated_at IS NOT NULL AND e\.generated_at > \(p\.j->>'generated_at'\)::timestamptz\)\s+RETURNING e\.consult_uid/);
    expect(INGEST_SQL).toMatch(/\(SELECT count\(\*\) FROM stale\)::integer AS stale/);
    process.env.ENCOUNTER_CATALOG_INGEST_SECRET = SECRET;
    const b = JSON.stringify({ rows: [row(), row({ consult_uid: "synth-cat-2" })] });
    H.script = () => [{ updated: 1, inserted: 0, stale: 1 }];
    const res = await ingest(post(b, signed(b, Math.floor(Date.now() / 1000))));
    expect([res.status, await res.json(), H.calls.length]).toEqual([200, { ok: true, updated: 1, inserted: 0, stale: 1 }, 1]);
  });
  it("C4: the README states that individual_uid / prescription_uid search params are in Vercel logs by design, and that ?token= is refused", () => {
    const md = readFileSync("lib/encounter-catalog/README.md", "utf8");
    expect(md).toMatch(/individual_uid.*prescription_uid.*Vercel request logs/s);
    expect(md).toMatch(/by design/i);
    expect(md).toMatch(/token.*query parameter.*refused/is);
    expect(md).toMatch(/2026-09-09/);
  });
});

describe("POST /api/encounter-catalog/ingest", () => {
  const body = () => JSON.stringify({ rows: [row(), row({ consult_uid: "synth-cat-2" })] });
  it("503 when the secret is unset, 401 on a bad signature, nothing written either way", async () => {
    let b = body();
    expect((await ingest(post(b, signed(b)))).status).toBe(503);
    process.env.ENCOUNTER_CATALOG_INGEST_SECRET = SECRET;
    const ts = Math.floor(Date.now() / 1000);
    expect((await ingest(post(b, { [CATALOG_TS_HEADER]: String(ts), [CATALOG_SIG_HEADER]: "0".repeat(64) }))).status).toBe(401);
    b = body();
    expect((await ingest(post(b + " ", signed(b, ts)))).status).toBe(401);
    expect(H.calls).toEqual([]);
  });
  it("400 on a text key (a code, never the value) and writes nothing", async () => {
    process.env.ENCOUNTER_CATALOG_INGEST_SECRET = SECRET;
    const b = JSON.stringify({ rows: [row({ stages: { stt: { state: "ok", note: "the patient said hello" } } })] });
    const res = await ingest(post(b, signed(b, Math.floor(Date.now() / 1000))));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j).toEqual({ ok: false, error: "text_key" });
    expect(JSON.stringify(j)).not.toContain("patient");
    expect(H.calls).toEqual([]);
  });
  it("200 upserts through one statement with the rows as $1 and returns the counts; a db error is 503 db:<sqlstate>", async () => {
    process.env.ENCOUNTER_CATALOG_INGEST_SECRET = SECRET;
    const b = body();
    H.result = [{ updated: 1, inserted: 1, stale: 0 }];
    const res = await ingest(post(b, signed(b, Math.floor(Date.now() / 1000))));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, updated: 1, inserted: 1, stale: 0 });
    expect(H.calls).toHaveLength(1);
    expect(H.calls[0][0]).toBe(INGEST_SQL);
    expect(JSON.parse(H.calls[0][1][0] as string)).toHaveLength(2);
    H.fail = { code: "23514" };
    const r2 = await ingest(post(b, signed(b, Math.floor(Date.now() / 1000))));
    expect([r2.status, await r2.json()]).toEqual([503, { ok: false, error: "db:23514" }]);
  });
  it("a row that was neither updated nor inserted triggers ONE rerun; still short => 409 (never a silent 200); recovered on the rerun => 200 with the counts; complete first time => no rerun", async () => {
    process.env.ENCOUNTER_CATALOG_INGEST_SECRET = SECRET;
    const b = body();                                                     // 2 rows
    const post2 = () => ingest(post(b, signed(b, Math.floor(Date.now() / 1000))));
    const script = (...rs: Array<{ updated: number; inserted: number }>) => { let n = 0; H.script = () => [rs[Math.min(n++, rs.length - 1)]]; H.calls.length = 0; };
    script({ updated: 0, inserted: 1 }, { updated: 1, inserted: 1 });
    const res = await post2();
    expect([res.status, await res.json(), H.calls.length]).toEqual([200, { ok: true, updated: 1, inserted: 1, stale: 0, retried: true }, 2]);
    script({ updated: 0, inserted: 1 }, { updated: 0, inserted: 1 });
    const res2 = await post2();
    expect([res2.status, await res2.json(), H.calls.length]).toEqual([409, { ok: false, error: "concurrent_insert", missing: 1 }, 2]);
    script({ updated: 1, inserted: 1 });
    const res3 = await post2();
    expect([res3.status, H.calls.length]).toEqual([200, 1]);
    expect(await ingestCatalogRows([row(), row({ consult_uid: "synth-cat-2" })] as never)).toEqual({ updated: 1, inserted: 1, stale: 0 });
    expect(new ConcurrentIngestError(1).message).toBe("concurrent_insert");
  });
  it("413 over the body limit, 400 on bad json", async () => {
    process.env.ENCOUNTER_CATALOG_INGEST_SECRET = SECRET;
    expect((await ingest(post("x".repeat(4_000_001), {}))).status).toBe(413);
    const b = "not json";
    expect((await ingest(post(b, signed(b, Math.floor(Date.now() / 1000))))).status).toBe(400);
  });
});

describe("GET /api/encounter-catalog/search", () => {
  it("401 without a token, with a wrong token, and when ADMIN_TOKEN is unset (unset refuses, never allows)", async () => {
    expect((await search(get(""))).status).toBe(401);
    process.env.ADMIN_TOKEN = "adm";
    expect((await search(get("", "wrong"))).status).toBe(401);
    expect((await search(get(""))).status).toBe(401);
    delete process.env.ADMIN_TOKEN;
    expect((await search(get("", "adm"))).status).toBe(401);
    expect(H.calls).toEqual([]);
  });
  it("accepts ADMIN_TOKEN as a bearer; 400 on a bad parameter before any query", async () => {
    process.env.ADMIN_TOKEN = "adm";
    expect((await search(get("?limit=0", "adm"))).status).toBe(400);
    expect(H.calls).toEqual([]);
    expect((await search(get("", "adm"))).status).toBe(200);
    expect(H.calls).toHaveLength(1);
  });
  it("ADMIN ONLY (PHI): the box read token and any other bearer are refused, with and without filters; an admin gets the identity columns and the prescription", async () => {
    process.env.ADMIN_TOKEN = "adm"; process.env.REB_INDEX_READ_TOKEN = "reader";
    for (const qs of ["", "?prescription_uid=rx_fake0001", "?doctor_uid=DOC12345"]) {
      expect((await search(get(qs, "reader"))).status).toBe(401);
      expect((await search(get(qs, "other"))).status).toBe(401);
    }
    expect(H.calls).toEqual([]);
    H.result = [{ consult_uid: "synth-cat-1", prescription: { prescription_uid: "rx_fake0001", presc_state: "final" }, patient_name: PAT_NAME }];
    const ok = await search(get("?prescription_uid=rx_fake0001&individual_uid=ind_fake0001", "adm"));
    expect(ok.status).toBe(200);
    expect((await ok.json()).rows[0].prescription).toEqual({ prescription_uid: "rx_fake0001", presc_state: "final" });
    expect(H.calls[0][0]).toMatch(/patient_name/);
    expect(H.calls[0][1]).toEqual(["rx_fake0001", "ind_fake0001", 101]);
  });
  it("returns the rows as stored with a next_cursor when there is more, null when there is not; a db error is 503", async () => {
    process.env.ADMIN_TOKEN = "adm";
    const mk = (i: number) => ({ consult_uid: "synth-cat-" + i, ist_date: "2026-10-1" + (i % 10), stages: { stt: { state: "ok", reason: null } } });
    H.result = [mk(3), mk(2), mk(1)];
    let res = await search(get("?limit=2", "adm"));
    let j = await res.json();
    expect([j.ok, j.count, j.rows.length, typeof j.next_cursor]).toEqual([true, 2, 2, "string"]);
    expect(JSON.parse(Buffer.from(j.next_cursor, "base64url").toString())).toEqual(["2026-10-12", "synth-cat-2"]);
    H.result = [mk(1)];
    res = await search(get("?limit=2", "adm"));
    j = await res.json();
    expect([j.count, j.next_cursor]).toEqual([1, null]);
    expect(res.headers.get("cache-control")).toBe("no-store");
    H.fail = { code: "42P01" };
    const r3 = await search(get("", "adm"));
    expect([r3.status, await r3.json()]).toEqual([503, { ok: false, error: "db:42P01" }]);
  });
});
