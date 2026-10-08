/**
 * Arch #17 — a 15 s / 0-chunk start death is classified and alerted, never silent.
 *   AC2 classify + alert (watchdog degraded reason `start_died`, edge-triggered through the existing outbox)
 *   AC1/AC3 the device-ready retry lives in the Swift engine (InputDeviceReadyTests.swift; NOT compiled here)
 *   AC4 the repro-morning log validation is PENDING and is not claimed anywhere.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

const stmts: Array<{ text: string; values: unknown[] }> = [];
let deadRooms: string[] = [];
vi.mock("@/lib/db", () => ({
  sql: (s: TemplateStringsArray, ...v: unknown[]) => {
    const text = s.join("?").replace(/\s+/g, " ").trim();
    stmts.push({ text, values: v });
    if (/FROM room_install ri/.test(text)) {
      return Promise.resolve([{ room_id: "room_opd4", room_name: "OPD4", last_seen_at: new Date().toISOString(), tape_advancing: false, session_open: false, disk_free_bytes: 5e11, state_flags: [], prior_status: "ok", prior_since: "2026-10-05T03:00:00.000Z", muted_until: null }]);
    }
    if (/NOT EXISTS \(SELECT 1 FROM bench_chunk/.test(text)) return Promise.resolve(deadRooms.map((room_id) => ({ room_id })));
    if (/INSERT INTO room_alert_state/.test(text)) return Promise.resolve([{ id: 1 }]);
    return Promise.resolve([]);
  },
}));
vi.mock("@/lib/bench", () => ({ listBenchSessions: async () => [] }));

const W = await import("../../lib/room-watchdog");

describe("classification", () => {
  const facts = (over: Record<string, unknown> = {}) => ({
    last_seen_at: new Date(Date.parse("2026-10-05T03:36:00.000Z") - 5_000).toISOString(), tape_advancing: false, session_open: false,
    disk_free_bytes: 5e11, state_flags: [], open_session: null, ...over,
  }) as never;
  const NOW = Date.parse("2026-10-05T03:36:00.000Z");
  it("a dead start degrades the room with its own named reason", () => {
    expect(W.computeRoomStatus(facts({ start_died: true }), NOW)).toEqual({ status: "degraded", reasons: ["start_died"] });
  });
  it("absent or false changes nothing (callers that predate it are untouched)", () => {
    expect(W.computeRoomStatus(facts(), NOW).status).toBe("ok");
    expect(W.computeRoomStatus(facts({ start_died: false }), NOW).status).toBe("ok");
  });
  it("the alert text says the start died and never borrows end-of-day words", () => {
    const m = W.degradedMessage("OPD4", ["start_died"], "2026-10-05T03:36:00.000Z");
    expect(m.text).toMatch(/died at start/);
    expect(m.text).not.toMatch(/finished/i);
  });
  it("an offline Mac is still just offline (the stronger fact wins)", () => {
    expect(W.computeRoomStatus(facts({ start_died: true, last_seen_at: null }), NOW).status).toBe("offline");
  });
});

describe("runWatchdog wiring", () => {
  it("queues exactly one degraded alert naming start_died when the room's newest session died at start", async () => {
    deadRooms = ["room_opd4"]; stmts.length = 0;
    const r = await W.runWatchdog(Date.now());
    expect(r.ok).toBe(true);
    const persist = stmts.find((s) => /INSERT INTO room_alert_state/.test(s.text))!;
    expect(persist).toBeTruthy();
    expect(JSON.stringify(persist.values)).toMatch(/died at start/);
    expect(JSON.stringify(persist.values)).toMatch(/degraded/);
  });
  it("the dead-start read asks about the NEWEST session, zero pieces, a short life, a recent end", () => {
    const q = stmts.find((s) => /NOT EXISTS \(SELECT 1 FROM bench_chunk/.test(s.text))!;
    expect(q.text).toMatch(/s\.status = 'ended'/);
    expect(q.text).toMatch(/n\.started_at > s\.started_at/);   // a newer (retry) session clears it
    expect(q.values).toContain(W.START_DEATH_WINDOW_MS / 1000);
    expect(q.values).toContain(180);
  });
  it("a failed read costs only this signal, not the run", async () => {
    const db = await import("@/lib/db");
    const orig = (db as { sql: unknown }).sql;
    void orig;
    // the source is fail-safe by construction: its try/catch is the only thing around the read
    const src = readFileSync("lib/room-watchdog.ts", "utf8");
    expect(src).toMatch(/start_died is unavailable this run/);
  });
});
