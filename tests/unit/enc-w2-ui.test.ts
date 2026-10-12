/**
 * ENC-W2 admin UI: pure helpers, query mappers (sql mocked) and static renders. Fake ids, no names, no live DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

type Row = Record<string, unknown>;
const calls: Array<{ text: string; values: unknown[] }> = [];
let responder: (text: string) => Row[] = () => [];
let failNext = false;

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    if (failNext) return Promise.reject(new Error("relation does not exist"));
    return Promise.resolve(responder(text));
  };
  return { sql, db: {} };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));

const Q = await import("@/lib/enc/queries");
const V = await import("@/lib/enc/view");
const { DailyCoverageClient } = await import("@/components/admin/enc/DailyCoverageClient");
const { RoomDayTimeline } = await import("@/components/admin/enc/RoomDayTimeline");
const { EncIsolationSections } = await import("@/components/admin/enc/EncIsolationSections");
const { StewardClient } = await import("@/components/admin/enc/StewardClient");
const { EncLights } = await import("@/components/admin/enc/EncLights");
const { RoomsTabs } = await import("@/components/admin/enc/RoomsTabs");

beforeEach(() => {
  calls.length = 0;
  responder = () => [];
  failNext = false;
});

const DATE = "2026-10-12";
const t = (hhmm: string) => `${DATE}T${hhmm}:00+05:30`;
const ms = (hhmm: string) => Date.parse(t(hhmm));

function dayRow(over: Partial<ReturnType<typeof Q.mapRoomDay>> = {}) {
  return {
    ist_date: DATE, room_id: "room-a", visits: 10, placed: 9, isolated: 8, isolated_pulse: 5, isolated_pqm: 3, not_isolated: 2,
    lane_sarvam: 7, lane_nemotron: 6, lane_role: 5, lane_parts: 4, rx_matched: 3, tape_hours: 7.5, status: "warn" as const,
    alerts: [{ code: "GAP", message: "gap in tape", count: 2 }, { code: "LATE", message: "late export", count: 5 }],
    computed_at: t("21:00"), source: "recon-1", ...over,
  };
}
function isoRow(over: Partial<ReturnType<typeof Q.mapIsolation>> = {}) {
  return {
    consult_uid: "uid-1", ist_date: DATE, room_id: "room-a", doctor_uid: "doc-1", t_start: t("10:00"), t_end: t("10:20"),
    boundary_source: "pulse" as const, room_source: "pulse", confidence: 0.9, status: "cut" as const, skip_reason: null, r2_prefix: null,
    lanes: { sarvam: true, nemotron: false }, parts: null, rx: null, pqm_step_uid: "step-1", updated_at: t("21:00"), ...over,
  };
}

describe("view helpers", () => {
  it("topAlert picks the highest count, null for none", () => {
    expect(V.topAlert(dayRow().alerts)?.code).toBe("LATE");
    expect(V.topAlert([])).toBeNull();
  });
  it("buildCoverageRows: a room with no row is nodata, never ok; disabled rooms without data are dropped", () => {
    const rows = V.buildCoverageRows(
      [{ id: "room-a", name: "Room A" }, { id: "room-b", name: "Room B" }, { id: "room-c", name: "Room C", disabled_at: "2026-01-01" }],
      [dayRow()],
    );
    expect(rows.map((r) => r.room_id)).toEqual(["room-a", "room-b"]);
    expect(rows[0]).toMatchObject({ visits: 10, placed: 9, isolated: 8, processed: 7, rx_matched: 3, status: "warn", top_alert: "late export (5)" });
    expect(rows[1]).toMatchObject({ has_data: false, status: "nodata", top_alert: null });
  });
  it("parseIstDate rejects bad dates; istToday is IST", () => {
    expect(V.parseIstDate("2026-10-12")).toBe("2026-10-12");
    expect(V.parseIstDate("2026-13-45")).toBeNull();
    expect(V.parseIstDate("x")).toBeNull();
    expect(V.parseIstDate(undefined)).toBeNull();
    expect(V.istToday(Date.parse("2026-10-12T20:00:00Z"))).toBe("2026-10-13");
  });
  it("buildTimeline: cut rows become encounters, a visit with no cut over it is a gap, no_recording is a tape gap", () => {
    const isos = [
      isoRow(),
      isoRow({ consult_uid: "uid-2", pqm_step_uid: "step-2", t_start: t("11:00"), t_end: t("11:15"), status: "planned", boundary_source: "pqm" }),
    ];
    const tape = [
      { start_ms: ms("09:00"), end_ms: ms("10:30"), recorded: true },
      { start_ms: ms("10:30"), end_ms: ms("11:30"), recorded: false },
    ];
    const m = V.buildTimeline(DATE, isos, tape);
    expect(m.encounters.map((e) => e.id)).toEqual(["uid-1"]);
    expect(m.visits.map((v) => [v.id, v.isolated])).toEqual([["uid-1", true], ["uid-2", false]]);
    expect(m.unisolatedVisits).toBe(1);
    expect(m.tapeGaps).toHaveLength(1);
    expect(m.tape).toHaveLength(1);
    for (const s of [...m.encounters, ...m.visits, ...m.tape, ...m.tapeGaps]) {
      expect(s.left).toBeGreaterThanOrEqual(0);
      expect(s.left + s.width).toBeLessThanOrEqual(100.5);
    }
  });
  it("timelineBounds defaults to 08-20 IST with no data", () => {
    const b = V.timelineBounds(DATE, [], []);
    expect((b.endMs - b.startMs) / 3600_000).toBe(12);
  });
  it("splitItems and spendMeter", () => {
    const base = { run_id: "r", ist_date: null, room_id: null, consult_uid: null, body_md: "", proposed_action: null, decided_by: null, decided_at: null, result: null, created_at: t("09:00") };
    const items = [
      { ...base, id: "1", kind: "suggestion", title: "a", state: "open" },
      { ...base, id: "2", kind: "question", title: "b", state: "open" },
      { ...base, id: "3", kind: "action", title: "c", state: "approved" },
    ] as Parameters<typeof V.splitItems>[0];
    const s = V.splitItems(items);
    expect([s.decisions.length, s.questions.length, s.decided.length]).toEqual([1, 1, 1]);
    expect(V.spendMeter(1, null)).toEqual({ ratio: null, tone: "ok" });
    expect(V.spendMeter(8, 10).tone).toBe("warn");
    expect(V.spendMeter(12, 10)).toEqual({ ratio: 1, tone: "alert" });
  });
  it("encLights: green when fresh, red when stale, never, or failed", () => {
    const now = Date.parse(t("12:00"));
    const fresh = V.encLights({ last_computed_at: t("08:00"), last_run_status: "ok", last_run_started_at: t("09:00") }, now);
    expect(fresh.map((l) => l.ok)).toEqual([true, true]);
    const bad = V.encLights({ last_computed_at: null, last_run_status: "failed", last_run_started_at: t("09:00") }, now);
    expect(bad.map((l) => l.ok)).toEqual([false, false]);
    const old = V.encLights({ last_computed_at: "2026-10-01T00:00:00Z", last_run_status: "ok", last_run_started_at: "2026-10-01T00:00:00Z" }, now);
    expect(old.map((l) => l.ok)).toEqual([false, false]);
  });
});

describe("queries (sql mocked)", () => {
  it("getRoomDay binds the date, reads enc_room_day and maps numerics", async () => {
    responder = () => [{ ...dayRow(), visits: "10", tape_hours: "7.5" }];
    const rows = await Q.getRoomDay(DATE);
    expect(calls[0]!.text).toContain("FROM enc_room_day");
    expect(calls[0]!.values).toEqual([DATE]);
    expect(rows[0]).toMatchObject({ visits: 10, tape_hours: 7.5 });
  });
  it("getRoomDayDetail reads both tables", async () => {
    responder = (text) => (text.includes("enc_isolation") ? [isoRow()] : [dayRow()]);
    const d = await Q.getRoomDayDetail("room-a", DATE);
    expect(d.day?.room_id).toBe("room-a");
    expect(d.isolations[0]!.consult_uid).toBe("uid-1");
  });
  it("getIsolation returns null for no row", async () => {
    expect(await Q.getIsolation("nope")).toBeNull();
  });
  it("every read fails safe when the table is missing", async () => {
    failNext = true;
    expect(await Q.getRoomDay(DATE)).toEqual([]);
    expect(await Q.getRoomDayDetail("r", DATE)).toEqual({ day: null, isolations: [] });
    expect(await Q.getIsolation("x")).toBeNull();
    expect(await Q.getStewardItems()).toEqual([]);
    expect(await Q.getStewardRuns()).toEqual([]);
    expect((await Q.getStewardSettings()).settings).toEqual(Q.DEFAULT_STEWARD_SETTINGS);
    expect((await Q.getEncHealth()).last_computed_at).toBeNull();
  });
  it("getStewardItems clamps the limit and binds state", async () => {
    await Q.getStewardItems({ state: "approved", limit: 99999 });
    expect(calls[0]!.values).toEqual(["approved", "approved", 500]);
  });
  it("settingsFromRows: defaults are disabled + advise", () => {
    expect(Q.settingsFromRows([])).toEqual({ enabled: false, mode: "advise", daily_cap_usd: null, model_id: null });
    expect(Q.settingsFromRows([{ key: "enabled", value: true }, { key: "mode", value: "act" }, { key: "daily_cap_usd", value: 5 }, { key: "model_id", value: "m" }]))
      .toEqual({ enabled: true, mode: "act", daily_cap_usd: 5, model_id: "m" });
  });
});

describe("renders", () => {
  it("coverage table: columns, links, chips, no-data row", () => {
    const rows = V.buildCoverageRows([{ id: "room-a", name: "Room A" }, { id: "room-b", name: "Room B" }], [dayRow()]);
    const html = renderToStaticMarkup(React.createElement(DailyCoverageClient, { date: DATE, rows }));
    for (const h of ["Visits", "Placed", "Isolated", "Processed", "Rx matched", "Status", "Top alert"]) expect(html).toContain(h);
    expect(html).toContain(`href="/admin/rooms/room-a/${DATE}"`);
    expect(html).toContain("late export (5)");
    expect(html).toContain("no data");
    expect(html).toContain(`value="${DATE}"`);
    expect(html).toContain("overflow-x-auto");
  });
  it("tabs mark the active one", () => {
    expect(renderToStaticMarkup(React.createElement(RoomsTabs, { active: "coverage" }))).toMatch(/aria-current="page"[^>]*>Daily coverage|Daily coverage/);
  });
  it("timeline: encounter links, boundary colours, gap marks; nothing without data", () => {
    const isos = [isoRow(), isoRow({ consult_uid: "uid-2", pqm_step_uid: "step-2", t_start: t("11:00"), t_end: t("11:15"), status: "planned" })];
    const tape = [{ start_ms: ms("09:00"), end_ms: ms("10:30"), recorded: true }, { start_ms: ms("10:30"), end_ms: ms("11:30"), recorded: false }];
    const html = renderToStaticMarkup(React.createElement(RoomDayTimeline, { roomId: "room-a", date: DATE, day: dayRow(), isolations: isos, tape }));
    expect(html).toContain(`href="/admin/rooms/room-a/${DATE}#consult-uid-1"`);
    expect(html).not.toContain("#consult-uid-2");
    expect(html).not.toContain("/admin/encounters/");
    expect(html).toContain("bg-even-blue-600");
    expect(html).toContain('data-gap="tape"');
    expect(html).toContain('data-gap="visit"');
    expect(html).toContain("1 visit(s) have no isolated encounter");
    expect(renderToStaticMarkup(React.createElement(RoomDayTimeline, { roomId: "room-a", date: DATE, day: null, isolations: [], tape: [] }))).toBe("");
  });
  it("encounter sections: render nothing when absent; parts and rx only when present", () => {
    expect(renderToStaticMarkup(React.createElement(EncIsolationSections, { iso: null }))).toBe("");
    const min = renderToStaticMarkup(React.createElement(EncIsolationSections, { iso: isoRow() }));
    expect(min).toContain("Isolation");
    expect(min).not.toContain("Parts");
    expect(min).not.toContain("Rx check");
    const full = renderToStaticMarkup(
      React.createElement(EncIsolationSections, {
        iso: isoRow({ parts: [{ part: "history", t0: 0, t1: 125, score: 0.8 }], rx: { matched: false, rx_ref: "rx-1", mismatch: ["DOSE"] } }),
      }),
    );
    expect(full).toContain("Parts");
    expect(full).toContain("2:05");
    expect(full).toContain("Rx check");
    expect(full).toContain("not matched");
    expect(full).toContain("DOSE");
  });
  it("steward: buttons for open suggestions only, questions without buttons, switch, cap meter, history", () => {
    const base = { run_id: "r1", ist_date: DATE, room_id: null, consult_uid: null, body_md: "ids only", proposed_action: { type: "recut" }, decided_by: null, decided_at: null, result: null, created_at: t("09:00") };
    const items = [
      { ...base, id: "i1", kind: "suggestion", title: "Re-cut one consult", state: "open" },
      { ...base, id: "i2", kind: "question", title: "Which lane first", state: "open", proposed_action: null },
    ] as Parameters<typeof StewardClient>[0]["items"];
    const runs = [{ id: "r1", started_at: t("09:00"), ended_at: t("09:05"), mode: "advise", model: "m", tokens_in: 100, tokens_out: 50, cost_usd: 0.12, summary_md: "Two rooms need a look.", status: "ok" }] as Parameters<typeof StewardClient>[0]["runs"];
    const html = renderToStaticMarkup(
      React.createElement(StewardClient, { settings: { enabled: true, mode: "advise", daily_cap_usd: 10, model_id: "m" }, spendToday: 8.5, items, runs }),
    );
    expect(html.match(/>Approve</g)).toHaveLength(1);
    expect(html.match(/>Reject</g)).toHaveLength(1);
    expect(html).toContain("Which lane first");
    expect(html).toContain('role="switch"');
    expect(html).toContain("Spend today $8.50 of $10.00 cap");
    expect(html).toContain('aria-valuenow="85"');
    expect(html).toContain("Two rooms need a look.");
    expect(html).toContain("$0.120");
  });
  it("system-map lights: green and red", () => {
    const html = renderToStaticMarkup(React.createElement(EncLights, { lights: [{ key: "a", title: "A", ok: true, detail: "x" }, { key: "b", title: "B", ok: false, detail: "never" }] }));
    expect(html).toContain('data-light="green"');
    expect(html).toContain('data-light="red"');
  });
});

describe("contract guards", () => {
  it("queries.ts names no gated room table, and the nav carries the steward item", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/enc/queries.ts", "utf8");
    const { ROOM_TABLES } = await import("../support/room-access-scan");
    for (const tbl of ROOM_TABLES) expect(new RegExp(`(FROM|JOIN)\\s+${tbl}\\b`, "i").test(src), tbl).toBe(false);
    expect(readFileSync("components/admin/AdminShell.tsx", "utf8")).toContain('href: "/admin/steward"');
  });
});
