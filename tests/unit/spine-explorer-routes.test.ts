/** Spine S4b explorer routes: the guard (401, ?token 401, 404 when the flag is not on), 400s, empty-state zeros, and that the read module cannot write. The SQL itself is proven on postgres in spine-explorer-pg.test.ts. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

const M = vi.hoisted(() => ({ config: [] as Array<{ key: string; value: unknown }>, fail: false, calls: [] as string[] }));
vi.mock("@/lib/db", () => ({
  sql: async (text: string) => {
    M.calls.push(text);
    if (text.includes("FROM spine_config")) { if (M.fail) throw Object.assign(new Error("x"), { code: "08006" }); return M.config; }
    return [];
  },
}));

import { GET as DAY } from "@/app/api/spine/explorer/day/route";
import { GET as PAGE } from "@/app/api/spine/explorer/encounters/route";
import { GET as ONE } from "@/app/api/spine/explorer/encounter/[encounter_id]/route";
import { NextRequest } from "next/server";
import { parseExplorerOn } from "@/lib/spine/explorer-read";

const ID = "enc_testaaaaaaaaaaaa";
const req = (path: string, auth: string | null = "Bearer adm_test") => new NextRequest(`https://x.test${path}`, { headers: auth ? { authorization: auth } : {} });
const ROUTES: Array<[string, (r: NextRequest) => Promise<Response>, string]> = [
  ["day", (r) => DAY(r), "/api/spine/explorer/day?ist_date=2026-10-18"],
  ["encounters", (r) => PAGE(r), "/api/spine/explorer/encounters?ist_date=2026-10-18"],
  ["encounter", (r) => ONE(r, { params: Promise.resolve({ encounter_id: ID }) }), `/api/spine/explorer/encounter/${ID}`],
];
const SAVED = process.env.ADMIN_TOKEN;
beforeEach(() => { process.env.ADMIN_TOKEN = "adm_test"; M.config = [{ key: "explorer", value: "shadow" }]; M.fail = false; M.calls = []; });
afterEach(() => { if (SAVED === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = SAVED; });

describe.each(ROUTES)("%s route guard", (_n, call, path) => {
  it("401 without a bearer, with a wrong one, and with any ?token (even beside the right bearer); nothing is queried", async () => {
    expect((await call(req(path, null))).status).toBe(401);
    expect((await call(req(path, "Bearer wrong"))).status).toBe(401);
    expect((await call(req(path + (path.includes("?") ? "&" : "?") + "token=adm_test", "Bearer adm_test"))).status).toBe(401);
    expect((await call(req(path + (path.includes("?") ? "&" : "?") + "Token=adm_test", null))).status).toBe(401);
    expect(M.calls).toEqual([]);
  });
  it("401 when ADMIN_TOKEN is unset", async () => { delete process.env.ADMIN_TOKEN; expect((await call(req(path))).status).toBe(401); });
  it("404 when the explorer flag is missing, off, malformed or unreadable", async () => {
    for (const cfg of [[], [{ key: "explorer", value: "off" }], [{ key: "explorer", value: false }], [{ key: "explorer", value: 42 }], [{ key: "explorer", value: { mode: "banana" } }], [{ key: "explorer", value: "{not json" }]]) {
      M.config = cfg;
      expect((await call(req(path))).status, JSON.stringify(cfg)).toBe(404);
    }
    M.fail = true;
    expect((await call(req(path))).status).toBe(404);
  });
});

describe("parseExplorerOn", () => {
  it("accepts true / on / shadow in the plain, object and JSON-text forms only", () => {
    for (const v of [true, "on", "shadow", { on: true }, { mode: "on" }, { mode: "shadow" }, '"shadow"', "true"]) expect(parseExplorerOn([{ key: "explorer", value: v }]), JSON.stringify(v)).toBe(true);
    for (const v of [false, "off", "live", null, 1, {}, { on: "true" }, { mode: "live" }, []]) expect(parseExplorerOn([{ key: "explorer", value: v }]), JSON.stringify(v)).toBe(false);
    expect(parseExplorerOn([{ key: "other", value: true }])).toBe(false);
  });
});

describe("parameters", () => {
  it("400 for a bad or pre-floor date, room, status, flag, cursor, limit, encounter id", async () => {
    for (const p of ["", "?ist_date=2026-02-30", "?ist_date=2026-09-08", "?ist_date=2026-10-18&room_id=a/b"]) expect((await DAY(req("/api/spine/explorer/day" + p))).status, p).toBe(400);
    for (const p of ["&status=open", "&flag=bogus", "&cursor=zzz", "&limit=201", "&limit=0", "&room_id=%3Bx"]) expect((await PAGE(req("/api/spine/explorer/encounters?ist_date=2026-10-18" + p))).status, p).toBe(400);
    expect((await ONE(req("/api/spine/explorer/encounter/x"), { params: Promise.resolve({ encounter_id: "enc_short" }) })).status).toBe(400);
  });
});

describe("empty tables", () => {
  it("day: no rooms; with a room filter, that room with zeros everywhere", async () => {
    expect(await (await DAY(req("/api/spine/explorer/day?ist_date=2026-10-18"))).json()).toEqual({ ok: true, ist_date: "2026-10-18", rooms: [] });
    const body = await (await DAY(req("/api/spine/explorer/day?ist_date=2026-10-18&room_id=room_x"))).json();
    expect(body.rooms).toEqual([{
      room_id: "room_x", encounters: { candidate: 0, confirmed: 0, rejected: 0, merged: 0, total: 0 }, flags: { ambiguous: 0, multi_machine: 0, pulse_overlap: 0 },
      signals_by_proxy: { pulse: 0, pqm: 0, acoustic: 0, timeline: 0, doctor_activity: 0, cutter: 0, caa: 0, nemotron_window: 0 }, jobs_by_stage: {},
    }]);
  });
  it("encounters: an empty page; encounter: 404 for an unknown id", async () => {
    expect(await (await PAGE(req("/api/spine/explorer/encounters?ist_date=2026-10-18"))).json()).toEqual({ ok: true, count: 0, next_cursor: null, rows: [] });
    expect((await ONE(req(`/api/spine/explorer/encounter/${ID}`), { params: Promise.resolve({ encounter_id: ID }) })).status).toBe(404);
  });
});

describe("read-only", () => {
  it("lib/spine/explorer-read.ts and the routes contain no INSERT, UPDATE, DELETE, TRUNCATE, DROP, ALTER or CREATE", () => {
    for (const f of ["lib/spine/explorer-read.ts", "lib/spine/explorer-route.ts", "app/api/spine/explorer/day/route.ts", "app/api/spine/explorer/encounters/route.ts", "app/api/spine/explorer/encounter/[encounter_id]/route.ts"]) {
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/i);
    }
  });
  it("selects no identity column and joins no catalog table", () => {
    const code = readFileSync("lib/spine/explorer-read.ts", "utf8");
    expect(code).not.toMatch(/encounter_catalog|doctor_name|patient_name|individual_uid|prescription/);
  });
});
