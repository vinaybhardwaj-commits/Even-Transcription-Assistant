/** Rooms Live v1.7 addendum A1 (S7 / S8): the Steward log page. Read bounds, collapse, empty day, links on every card, auth, bad slug, bad date. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

(globalThis as { React?: unknown }).React = React;

const M = vi.hoisted(() => ({ guard: vi.fn(), calls: [] as Array<{ sql: string; values: unknown[] }>, order: [] as string[], history: [] as Array<Record<string, unknown>> }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); }, redirect: (u: string) => { throw new Error(`NEXT_REDIRECT ${u}`); } }));
vi.mock("@/lib/rooms-live/guard", () => ({ roomsLivePageGuard: async () => { M.order.push("guard"); return M.guard(); } }));
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    M.order.push("sql");
    M.calls.push({ sql: text, values });
    if (/FROM steward_decisions/.test(text)) return Promise.resolve(M.history);
    return Promise.resolve([]);
  },
}));

import RoomPage from "@/app/rooms-live/steward/[room]/page";
import AllPage from "@/app/rooms-live/steward/page";
import { readStewardHistory } from "@/lib/rooms-live/read";
import { collapseRows, parseDay, resultWords } from "@/lib/rooms-live/steward-history";
import { loadLogPage } from "@/lib/rooms-live/steward-log-page";
import { resetRosterForTests } from "@/lib/rooms-live/roster";
import { StewardLogView } from "@/components/rooms-live/StewardLogView";
import { RoomTile } from "@/components/rooms-live/RoomTile";
import type { RoomRow } from "@/lib/rooms-live/snapshot";

const NOW = Date.parse("2026-10-08T12:50:00Z"); // 18:20 IST, IST day 2026-10-08
const ROOM = "room_ux92qpws";
const hist = (ts: string, over: Record<string, unknown> = {}) => ({ room_id: ROOM, ts, rule: "ok", action: "none", mode: "shadow", result: null, pstate: null, ...over });

beforeEach(() => {
  resetRosterForTests();
  M.guard.mockReset();
  M.guard.mockResolvedValue({ kind: "open", name: "staff" });
  M.calls.length = 0;
  M.order.length = 0;
  M.history = [];
});

describe("read SQL bounds", () => {
  const fake = () => {
    const seen: { sql: string; values: unknown[] } = { sql: "", values: [] };
    const db = ((s: TemplateStringsArray, ...v: unknown[]) => { seen.sql = s.join("?"); seen.values = v; return Promise.resolve([]); }) as never;
    return { db, seen };
  };
  it("is clamped to 30 days (720 h) and to now, reads steward_decisions only, LIMIT 200 + 1 with OFFSET, room-bound", async () => {
    const { db, seen } = fake();
    await readStewardHistory(db, [ROOM], "2026-10-08T12:50:00Z", "2026-10-07T18:30:00Z", "2026-10-08T18:30:00Z", true, 200);
    expect(seen.sql).toMatch(/FROM steward_decisions/);
    expect(seen.sql).toMatch(/interval '720 hours'/);
    expect(seen.sql).toMatch(/d\.ts <= \?::timestamptz/);
    expect(seen.sql).toMatch(/d\.room_id = ANY\(\?::text\[\]\)/);
    expect(seen.sql).toMatch(/LIMIT 201 OFFSET/);
    expect(seen.sql).not.toMatch(/params->>'(why|inputs)|nonce|signature|payload/i);
    expect(seen.values[0]).toEqual([ROOM]);
    expect(seen.values.at(-1)).toBe(200);
  });
  it("actions-only is a bound flag over `action NOT IN (none, log_only)`; everything passes false", async () => {
    const a = fake();
    await readStewardHistory(a.db, [ROOM], "2026-10-08T12:50:00Z", "a", "b", true, 0);
    expect(a.seen.sql).toMatch(/NOT \?::boolean OR d\.action NOT IN \('none', 'log_only'\)/);
    expect(a.seen.values).toContain(true);
    const b = fake();
    await readStewardHistory(b.db, [ROOM], "2026-10-08T12:50:00Z", "a", "b", false, 0);
    expect(b.seen.values).toContain(false);
  });
  it("a hostile offset is clamped (negative -> 0, huge -> 10000, NaN -> 0)", async () => {
    for (const [o, want] of [[-5, 0], [1e9, 10_000], [Number.NaN, 0]] as const) {
      const { db, seen } = fake();
      await readStewardHistory(db, [ROOM], "2026-10-08T12:50:00Z", "a", "b", true, o);
      expect(seen.values.at(-1)).toBe(want);
    }
  });
  it("the page passes the one room, or every roster room, and the IST day bounds", async () => {
    await loadLogPage(((s: TemplateStringsArray, ...v: unknown[]) => { M.calls.push({ sql: s.join("?"), values: v }); return Promise.resolve([]); }) as never, { room: ROOM }, NOW);
    const h = M.calls.find((c) => /FROM steward_decisions/.test(c.sql))!;
    expect(h.values[0]).toEqual([ROOM]);
    expect(h.values[1]).toBe("2026-10-07T18:30:00.000Z"); // IST midnight
    expect(h.values[2]).toBe("2026-10-08T18:30:00.000Z");
    expect(h.values[3]).toBe("2026-10-08T12:50:00.000Z"); // the clamp / future bound
    resetRosterForTests();
    M.calls.length = 0;
    await loadLogPage(((s: TemplateStringsArray, ...v: unknown[]) => { M.calls.push({ sql: s.join("?"), values: v }); return Promise.resolve([]); }) as never, { room: null }, NOW);
    expect((M.calls.find((c) => /FROM steward_decisions/.test(c.sql))!.values[0] as string[]).length).toBe(8);
  });
});

describe("parseDay", () => {
  it("today by default; a day within 30 days is honoured; anything else is today", () => {
    expect(parseDay(null, NOW).date).toBe("2026-10-08");
    expect(parseDay("2026-10-01", NOW).date).toBe("2026-10-01");
    expect(parseDay("2026-09-08", NOW).date).toBe("2026-09-08"); // exactly 30 days back
    for (const bad of ["2026-09-07", "2026-10-09", "garbage", "2026-02-31", "", "2026-10-1", "'; DROP TABLE x;--"]) expect(parseDay(bad, NOW).date, bad).toBe("2026-10-08");
    expect(parseDay("2026-10-01", NOW).isToday).toBe(false);
  });
});

describe("collapse", () => {
  it("consecutive ok rows of one mode become one 'All fine HH:MM-HH:MM' with no count; anything else breaks the run", () => {
    // newest first, IST = UTC + 5:30
    const rows = [hist("2026-10-08T07:10:00Z"), hist("2026-10-08T07:09:00Z"), hist("2026-10-08T07:08:00Z"), hist("2026-10-08T07:07:00Z", { rule: "not_recording", action: "scribe_start", mode: "live", result: "ok: start_day acked" }), hist("2026-10-08T07:06:00Z"), hist("2026-10-08T07:05:00Z", { mode: "live" })];
    const out = collapseRows(rows);
    expect(out.map((x) => x.type)).toEqual(["fine", "row", "fine", "fine"]);
    expect((out[0] as { text: string }).text).toBe("All fine 12:38-12:40");
    expect((out[2] as { text: string }).text).toBe("All fine 12:36");
    expect((out[1] as { result: string }).result).toBe("done");
    for (const x of out) expect((x as { text?: string }).text ?? "").not.toMatch(/check|\(\d+/);
  });
  it("a run does not merge across rooms; no raw names in any text", () => {
    const out = collapseRows([hist("2026-10-08T07:10:00Z"), hist("2026-10-08T07:09:00Z", { room_id: "room_4ggnkg5x" }), hist("2026-10-08T07:08:00Z", { rule: "session_died", action: "message", mode: "shadow", result: "kill_switch" })]);
    expect(out.length).toBe(3);
    for (const x of out) expect(JSON.stringify(x)).not.toMatch(/session_died|kill_switch|scribe_|log_only|\bnone\b/);
  });
  it("result words", () => {
    const r = (mode: string, result: string | null, action = "scribe_start") => resultWords({ rule: "not_recording", action, mode, result, ts: "2026-10-08T02:00:00Z" });
    expect(r("live", "ok: x")).toBe("done");
    expect(r("live", "failed: no ack after 60 s")).toBe("kiosk didn't answer");
    expect(r("live", "skipped: kiosk not listening")).toBe("skipped, kiosk not ready");
    expect(r("live", "skipped: budget")).toBe("not sent");
    expect(r("shadow", "shadow: would")).toBe("not done (watching only)");
    expect(r("live", "ok", "none")).toBe("");
  });
});

describe("the page view", () => {
  const roomPage = async (hist: Array<Record<string, unknown>>, q: Parameters<typeof loadLogPage>[1] = { room: ROOM }) => {
    M.history = hist;
    const p = await loadLogPage((((s: TemplateStringsArray, ...v: unknown[]) => (M.calls.push({ sql: s.join("?"), values: v }), Promise.resolve(/FROM steward_decisions/.test(s.join("?")) ? M.history : []))) as never), q, NOW);
    if (p === "no_such_room") throw new Error("room");
    return renderToStaticMarkup(createElement(StewardLogView, { page: p }));
  };
  it("a room with zero decisions today renders 'No Steward activity today'", async () => {
    const m = await roomPage([]);
    expect(m).toContain("No Steward activity today");
    expect(m).toContain("OPD 4 Ortho");
  });
  it("an empty Older page (offset > 0) says there is no older activity; offset 0 keeps today / date wording", async () => {
    expect(await roomPage([], { room: ROOM, offset: "200" })).toContain("No older Steward activity on this day");
    expect(await roomPage([], { room: ROOM, offset: "200" })).not.toContain("No Steward activity today");
    expect(await roomPage([], { room: ROOM, date: "2026-10-01", offset: "200" })).toContain("No older Steward activity on this day");
    expect(await roomPage([], { room: ROOM, offset: "0" })).toContain("No Steward activity today");
    expect(await roomPage([], { room: ROOM, date: "2026-10-01" })).toContain("No Steward activity on 2026-10-01");
  });
  it("R1: params text (nonce, signature, why) never reaches the HTML, even if the row carries it", async () => {
    const secret = { nonce: "NONCE-MARK-91", signature: "SIG-MARK-77", why: "WHY-MARK-55 patient name" };
    const carry = { pstate: JSON.stringify(secret), params: secret, params_text: JSON.stringify(secret), why: secret.why, inputs: secret, nonce: secret.nonce, signature: secret.signature };
    const m = await roomPage([
      hist("2026-10-08T02:00:00Z", { rule: "not_recording", action: "scribe_start", mode: "live", result: "ok: start_day acked", ...carry }),
      hist("2026-10-08T01:00:00Z", { rule: "session_died", action: "message", mode: "shadow", result: "kill_switch", ...carry }),
      hist("2026-10-08T00:30:00Z", { rule: "doctor_away", action: "log_only", ...carry }),
    ], { room: ROOM, show: "everything" });
    expect(m).toContain("Steward started recording");
    for (const marker of ["NONCE-MARK-91", "SIG-MARK-77", "WHY-MARK-55", "nonce", "signature", "patient name"]) expect(m, marker).not.toContain(marker);
    // the read selects the state word only, never the params column itself
    const sel = M.calls.find((c) => /FROM steward_decisions/.test(c.sql))!.sql;
    expect(sel).toMatch(/d\.params->>'state' AS pstate/);
    expect(sel).not.toMatch(/params::text|d\.params\s*[,\n]|to_jsonb|row_to_json|SELECT \*/i);
  });
  it("another day says its date; rows show Live / Watching only, the sentence, the result, and a toggle that defaults to actions", async () => {
    const m = await roomPage([hist("2026-10-08T02:00:00Z", { rule: "not_recording", action: "scribe_start", mode: "live", result: "failed: no ack after 60 s" }), hist("2026-10-08T01:00:00Z", { rule: "not_recording", action: "scribe_start", mode: "shadow", result: "kill_switch" })]);
    expect(m).toContain("Live");
    expect(m).toContain("Watching only");
    expect(m).toContain("kiosk didn&#x27;t answer");
    expect(m).toContain("Things it did or wanted to do");
    expect(m).toContain("Everything");
    expect(m).not.toMatch(/not_recording|scribe_start|kill_switch/);
    expect(await roomPage([], { room: ROOM, date: "2026-10-01" })).toContain("No Steward activity on 2026-10-01");
  });
  it("200 rows + 1 means a next page; the extra row is not shown", async () => {
    const rows = Array.from({ length: 201 }, (_, i) => hist(new Date(Date.parse("2026-10-08T07:00:00Z") - i * 1000).toISOString(), { rule: "not_recording", action: "scribe_start", mode: "live", result: "ok: x" }));
    const m = await roomPage(rows);
    expect((m.match(/<li/g) ?? []).length).toBe(200);
    expect(m).toContain("offset=200");
  });
});

describe("links", () => {
  const base: RoomRow = {
    room_id: ROOM, label: "OPD 4", doctor: { display: "Dr Test", activity: "Signed in" }, doctor_known: true, state: "listening", state_since: null, detail_code: null,
    level: { rms: 0.01, zero: 0.001, at: null, stale: false }, baseline_rms: 0.009, device: { name: "C270", missing: false }, session: { open: true, since: null, chunk_age_s: 30 },
    steward: null, steward_line: null, steward_log: [], claim: null, ages_s: { listener: 1, heartbeat: 1, ext: 1 },
  };
  const tile = (o: Partial<RoomRow>, p: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(RoomTile, { row: { ...base, ...o }, nowMs: NOW, eng: false, onOpen: () => {}, ...p }));
  it("every card carries 'Steward log' -> /rooms-live/steward/<room>: Needs attention, Fine, No doctor signed in", () => {
    const attention = tile({ state: "off" }, { level: 3, durMs: 600_000, canClaim: true });
    const fine = tile({});
    const nodoc = tile({ doctor: null, doctor_known: true, state: "off" }, { calm: true });
    for (const m of [attention, fine, nodoc]) expect(m).toContain(`href="/rooms-live/steward/${ROOM}"`);
    expect(fine).toContain("Steward log</a>");
    expect(fine.indexOf("Listening") === -1 || fine.indexOf("steward-log-link") > fine.indexOf("<span")).toBe(true);
  });
  it("all three sections render through the one RoomTile, and the page links to 'All Steward logs' beside 'updated N s ago'", () => {
    const src = readFileSync(join(process.cwd(), "components/rooms-live/RoomsLiveClient.tsx"), "utf8");
    expect((src.match(/<RoomTile\b/g) ?? []).length).toBe(1);
    expect(src).toMatch(/updated \$\{age\} s ago[\s\S]{0,200}href="\/rooms-live\/steward"[^>]*>All Steward logs/);
  });
});

describe("routes: same access as /rooms-live, bad slug, bad date", () => {
  const run = (el: Promise<unknown>) => el;
  it("the guard runs before any read (both pages); the guard is the /rooms-live one", async () => {
    await RoomPage({ params: Promise.resolve({ room: ROOM }), searchParams: Promise.resolve({}) });
    expect(M.order[0]).toBe("guard");
    M.order.length = 0;
    resetRosterForTests();
    await AllPage({ searchParams: Promise.resolve({}) });
    expect(M.order[0]).toBe("guard");
    const src = readFileSync(join(process.cwd(), "app/rooms-live/page.tsx"), "utf8");
    expect(src).toContain('roomsLivePageGuard } from "@/lib/rooms-live/guard"');
  });
  it("a guard that throws stops the page before any read", async () => {
    M.guard.mockRejectedValueOnce(new Error("denied"));
    await expect(run(RoomPage({ params: Promise.resolve({ room: ROOM }), searchParams: Promise.resolve({}) }))).rejects.toThrow("denied");
    expect(M.calls.length).toBe(0);
  });
  it("a room slug off the roster is a 404 (nothing is read for it); a scratch / excluded room too", async () => {
    for (const bad of ["room_nope", "room_d74hhmc4", "../etc", "x"]) {
      resetRosterForTests();
      M.calls.length = 0;
      await expect(RoomPage({ params: Promise.resolve({ room: bad }), searchParams: Promise.resolve({}) }), bad).rejects.toThrow("NEXT_NOT_FOUND");
      expect(M.calls.some((c) => /FROM steward_decisions/.test(c.sql))).toBe(false);
    }
  });
  it("a bad date shows today (not 400)", async () => {
    await RoomPage({ params: Promise.resolve({ room: ROOM }), searchParams: Promise.resolve({ date: "not-a-date" }) });
    const h = M.calls.find((c) => /FROM steward_decisions/.test(c.sql))!;
    const today = new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
    expect(new Date(Date.parse(h.values[1] as string) + 19_800_000).toISOString().slice(0, 10)).toBe(today);
  });
  it("S8: ?room=<roster room> redirects to that room's page; an unknown ?room= shows all rooms", async () => {
    await expect(AllPage({ searchParams: Promise.resolve({ room: ROOM, show: "everything" }) })).rejects.toThrow(`NEXT_REDIRECT /rooms-live/steward/${ROOM}?show=everything`);
    resetRosterForTests();
    await expect(AllPage({ searchParams: Promise.resolve({ room: "room_nope" }) })).resolves.toBeTruthy();
  });
});
