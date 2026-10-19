/** Spine S1 R3: the Opus refute's adversarial route / cron tests (ported from .bc/oref-r2-tests; the parity dump became the shared fixture). Synthetic ids only. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const D = vi.hoisted(() => ({ handler: null as null | ((t: string, p: unknown[]) => Promise<Array<Record<string, unknown>>>), calls: [] as string[] }));
vi.mock("@/lib/db", () => ({ sql: async (t: string, p: unknown[]) => { D.calls.push(t); return D.handler!(t, p); } }));

import { validateSignals } from "@/lib/spine/signal-validate";
import { ingestSpineSignals, storeSignals } from "@/lib/spine/ingest-store";
import { POST } from "@/app/api/spine/signals/route";
import { GET } from "@/app/api/cron/spine/route";
import { NextRequest } from "next/server";

beforeEach(() => { D.calls.length = 0; });

const T_OPEN = new Date("2026-10-18T04:00:00.123Z"), T_CLOSE = new Date("2026-10-18T04:10:00.456Z");
describe("cron ingest on the REAL driver shape (Date source rows AND Date priors)", () => {
  it("an unchanged pulse window is not re-inserted; a changed close is rev 2", async () => {
    let close = T_CLOSE; const inserted: Array<Record<string, unknown>> = [];
    D.handler = async (t, p) => {
      if (/FROM spine_config/.test(t)) return [{ key: "ingest", value: "shadow" }];
      if (/FROM eta_encounter_windows/.test(t)) return [{ consult_key: "enc_testaaaaaaaaaaaa@mach_test", consult_uid: "enc_testaaaaaaaaaaaa", room_id: "room_abcd2345", t_open: new Date(T_OPEN), t_close: new Date(close), close_reason: "endConsult", quality: "clean", computed_at: new Date(T_CLOSE) }];
      if (/FROM spine_signal WHERE proxy/.test(t)) return p[0] === "pulse" ? [{ source_key: "enc_testaaaaaaaaaaaa@mach_test", source_rev: 1, room_id: "room_abcd2345", t_open: new Date(T_OPEN), t_close: new Date(T_CLOSE), close_reason: "endConsult" }] : [];
      if (/INSERT INTO spine_signal/.test(t)) { const rows = JSON.parse(p[0] as string); inserted.push(...rows); return rows.map((r: Record<string, unknown>) => ({ proxy: r.proxy, source_key: r.source_key, source_rev: r.source_rev })); }
      return [];
    };
    await ingestSpineSignals(Date.parse("2026-10-18T06:00:00Z"));
    expect(inserted.filter((r) => r.proxy === "pulse").map((r) => r.source_rev)).toEqual([1]);   // rev 1 = the stored rev: ON CONFLICT no-op
    inserted.length = 0;
    close = new Date("2026-10-18T04:11:00.456Z");
    await ingestSpineSignals(Date.parse("2026-10-18T06:00:00Z"));
    expect(inserted.filter((r) => r.proxy === "pulse").map((r) => r.source_rev)).toEqual([2]);
  });
  it("POST: Date priors with null close and null room = duplicate", async () => {
    D.handler = async (t, p) => (/FROM spine_signal WHERE proxy/.test(t) ? [{ source_key: "k_t", source_rev: 4, room_id: null, t_open: new Date(T_OPEN), t_close: null, close_reason: null }] : /INSERT/.test(t) ? JSON.parse(p[0] as string) : []);
    expect(await storeSignals([{ proxy: "cutter", source_key: "k_t", room_id: null, t_open: T_OPEN.toISOString(), t_close: null, observed_at: T_OPEN.toISOString(), attrs: {} }])).toEqual({ inserted: 0, duplicate: 1, conflict: 0 });
  });
});

const sig = { proxy: "pqm", source_key: "pqm_a1b2c3d4e5f6a7b8c9d0e1", t_open: "2026-10-18T04:00:00Z", observed_at: "2026-10-18T04:20:00Z", attrs: { ids: { consult_uid: "pqm_a1b2c3d4e5f6a7b8c9d0e1" } } };
const post = (body: unknown, auth?: string) => new NextRequest("https://x.test/api/spine/signals", { method: "POST", body: JSON.stringify(body), headers: auth === undefined ? {} : { authorization: auth } });
const cron = (auth?: string) => new Request("https://x.test/api/cron/spine", { headers: auth === undefined ? {} : { authorization: auth } });
describe("strict bearer on both routes", () => {
  beforeEach(() => { process.env.SPINE_INGEST_TOKEN = "tok_test"; process.env.CRON_SECRET = "cron_test"; D.handler = async () => []; });
  const bad = (tok: string) => ["Bearertok", `Bearer${tok}`, `Basic ${tok}`, `Token ${tok}`, `xearer ${tok}`, `Bearer:${tok}`, `Bearer\t${tok}`, `${tok}`, "Bearer ", `Bearer ${tok}x`, `Bearer ${tok.slice(0, -1)}`, `Bearer ${tok} ${tok}`];
  it("POST refuses every malformed scheme, accepts Bearer/bearer/BEARER", async () => {
    for (const h of bad("tok_test")) expect((await POST(post([sig], h))).status, h).toBe(401);
    for (const h of ["Bearer tok_test", "bearer tok_test", "BEARER tok_test", "Bearer  tok_test "]) expect((await POST(post([sig], h))).status, h).not.toBe(401);
  });
  it("cron refuses every malformed scheme; 503 when unset", async () => {
    for (const h of bad("cron_test")) expect((await GET(cron(h))).status, h).toBe(401);
    expect((await GET(cron("Bearer cron_test"))).status).toBe(200);
    delete process.env.CRON_SECRET; expect((await GET(cron("Bearer cron_test"))).status).toBe(503);
  });
  it("S0 R2 guard words email/uhid (and lookalikes) are 422 at the route, the DB is never touched", async () => {
    for (const k of ["email", "UHID", "uhid", "ｅmail", "e​mail", "Email_addr", "u̵hid"]) {
      for (const attrs of [{ [k]: "x" }, { ids: { [k]: "x" } }]) {
        D.calls.length = 0;
        const r = await POST(post([{ ...sig, attrs }], "Bearer tok_test"));
        expect(r.status, k).toBe(422); expect(D.calls.length).toBe(0);
      }
    }
  });
  it("a jsonb string kill_switch through the route = skipped off, nothing stored", async () => {
    D.handler = async (t) => (/FROM spine_config/.test(t) ? [{ key: "ingest", value: "shadow" }, { key: "kill_switch", value: "false" }] : []);
    const r = await POST(post([sig], "Bearer tok_test"));
    expect(await r.json()).toEqual({ ok: true, skipped: "off" });
    expect(D.calls.some((t) => /INSERT/.test(t))).toBe(false);
  });
});
