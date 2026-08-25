/**
 * Build 3 — recovery. The rules that turn two days of waiting tape into words and close the gaps
 * that stranded it. Behavioural where a fake can carry the rule (the day auto-open), and
 * source-anchored where the rule is a shape of SQL or a wiring the report has to be able to trust
 * (the migration touches no piece; the day opens in the chunk-verify path; a spare is a device,
 * not a piece; the door says the numbers the screen does).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const code = (...p: string[]): string =>
  readFileSync(join(process.cwd(), ...p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const raw = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), "utf8");

// ---------------------------------------------------------------------------
// §2.3 / D39 — the day record opens itself when tape starts.
// ---------------------------------------------------------------------------

const brainState = vi.hoisted(() => ({
  findRoomDay: vi.fn(),
  resolveRoomDay: vi.fn(),
}));
vi.mock("@/lib/brain/state", () => brainState);

import { ensureRoomDayOpen } from "@/lib/brain/open-day";

describe("D39 — a recording with no day record is a bug, so the day opens itself", () => {
  beforeEach(() => {
    brainState.findRoomDay.mockReset();
    brainState.resolveRoomDay.mockReset();
  });

  it("creates the day when the room had none for that IST date, keyed to the date it was asked for", async () => {
    brainState.findRoomDay.mockResolvedValue(null);
    brainState.resolveRoomDay.mockResolvedValue({ id: "rd_new", room_id: "room_x", ist_date: "2026-08-26" });
    const out = await ensureRoomDayOpen("room_x", "2026-08-26");
    expect(out).toEqual({ ok: true, created: true, room_day_id: "rd_new", ist_date: "2026-08-26" });
    // Resolve-or-create is the SAME durable path Mark consult writes through, and it is keyed to
    // the date passed in — the piece's own date, never the server clock.
    expect(brainState.resolveRoomDay).toHaveBeenCalledWith("room_x", "2026-08-26");
  });

  it("is idempotent — the second chunk of the day finds the record and creates nothing", async () => {
    brainState.findRoomDay.mockResolvedValue({ id: "rd_existing", room_id: "room_x", ist_date: "2026-08-26" });
    brainState.resolveRoomDay.mockResolvedValue({ id: "rd_existing", room_id: "room_x", ist_date: "2026-08-26" });
    const out = await ensureRoomDayOpen("room_x", "2026-08-26");
    expect(out.created).toBe(false);
    expect(out.room_day_id).toBe("rd_existing");
  });

  it("NEVER throws — a failed open is a value, so it cannot cost a chunk or an ack", async () => {
    brainState.findRoomDay.mockRejectedValue(new Error("brain_unreachable"));
    const out = await ensureRoomDayOpen("room_x", "2026-08-26");
    expect(out.ok).toBe(false);
    expect(out.created).toBe(false);
    expect(out.room_day_id).toBeNull();
    expect(out.error).toContain("brain_unreachable");
  });

  it("the chunk-verify path opens the day BEFORE the windows are written, keyed to the piece's own IST date", () => {
    const src = code("app", "api", "bench", "chunks", "route.ts");
    expect(src).toMatch(/ensureRoomDayOpen\(session\.room_id, istDateOf\(startedAt\.getTime\(\)\)\)/);
    // Before evaluateAndWriteWindows, so the day exists when the windows look it up and bind to it.
    expect(src.indexOf("ensureRoomDayOpen")).toBeLessThan(src.lastIndexOf("evaluateAndWriteWindows(sessionId)"));
  });

  it("the desk start also opens the day — on a successful start_day ack", () => {
    const src = code("app", "api", "bench", "commands", "[id]", "ack", "route.ts");
    expect(src).toMatch(/kind === "start_day"/);
    expect(src).toMatch(/ensureRoomDayOpen\(roomId, istDate\(\)\)/);
  });

  it("this subsumes the drain-side day creation — the window writer still only LOOKS UP a day", () => {
    const src = code("lib", "bench-window.ts");
    // A5 stands: bench-window.ts must not create a day. D39 puts the creation in the chunk-verify
    // path, not here, so there is no second, divergent way to make a day.
    expect(src).not.toMatch(/resolveRoomDay|ensureRoomDayOpen|INSERT INTO room_day/);
  });
});

// ---------------------------------------------------------------------------
// §2.2 / D34 — the re-bind migration, and the archive-wins rule it is held to.
// ---------------------------------------------------------------------------

describe("0068 — re-bind Cardiology's sixteen windows without costing a piece", () => {
  const mig = raw("db", "migrations", "0068_rebind_cardiology_and_spare_device.sql");

  it("touches NO piece — no chunk row and no R2 object is deleted, moved or rewritten", () => {
    // The archive always wins. A re-bind changes which microphone answers a window; a bench_chunk
    // is a piece and must never be in a write statement of this migration.
    expect(mig).not.toMatch(/DELETE\s+FROM\s+bench_chunk/i);
    expect(mig).not.toMatch(/UPDATE\s+bench_chunk/i);
    expect(mig).not.toMatch(/INSERT\s+INTO\s+bench_chunk/i);
  });

  it("scopes every data statement to the one affected session, bs_z3gpbh6e", () => {
    // Strip -- line comments first, so the prose header (which names the tables to explain them)
    // is not mistaken for a statement.
    const sqlOnly = mig.replace(/^\s*--.*$/gm, "");
    const stmts = sqlOnly.split(";").filter((s) => /\b(INSERT INTO|UPDATE|DELETE FROM)\b/i.test(s) && /\b(bench_window|stt_subject_job)\b/i.test(s));
    expect(stmts.length).toBeGreaterThan(0);
    for (const stmt of stmts) expect(stmt).toMatch(/bs_z3gpbh6e/);
  });

  it("is additive and idempotent — ADD COLUMN IF NOT EXISTS, ON CONFLICT, and it self-records", () => {
    expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS spare_device/);
    expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS rebind_reason/);
    expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS rebound_from/);
    expect(mig).toMatch(/ON CONFLICT \(session_id, start_ms, end_ms, source_mic\) DO UPDATE/);
    expect(mig).toMatch(/ON CONFLICT \(subject_type, subject_id, tier\) DO NOTHING/);
    expect(mig).toMatch(/INSERT INTO schema_migrations[\s\S]*VALUES \(68, '0068_rebind_cardiology_and_spare_device'\)/);
  });

  it("records the old binding, the new binding and the reason (D34)", () => {
    expect(mig).toMatch(/rebound_from/);
    expect(mig).toMatch(/rebind_reason/);
    expect(mig).toMatch(/'backup'/); // the old binding recorded on the new primary row
  });

  it("only ever promotes an OPEN slot to closed — never drags a settled window backwards (A8)", () => {
    expect(mig).toMatch(/CASE WHEN bench_window\.state = 'open' THEN 'closed' ELSE bench_window\.state END/);
  });
});

// ---------------------------------------------------------------------------
// §2.1 / §3.10 — run this room's waiting audio.
// ---------------------------------------------------------------------------

describe("§3.10 — the control that runs a room's waiting audio", () => {
  const drain = code("lib", "stt", "room-drain.ts");

  it("processes finished pieces with NO JOB AT ALL — closed, grid-aligned, with a day, oldest first", () => {
    const fn = /export async function drainRoomWaitingWindows[\s\S]*?\n}/.exec(drain)?.[0] ?? "";
    expect(fn).toMatch(/w\.state = 'closed'/);
    expect(fn).toMatch(/w\.grid_aligned = TRUE/);
    expect(fn).toMatch(/w\.room_day_id IS NOT NULL/);
    expect(fn).toMatch(/NOT EXISTS/);
    expect(fn).toMatch(/ORDER BY w\.start_ms ASC/);
  });

  it("runs a BOUNDED batch — a small cap so one request finishes and the operator sees the cost", () => {
    const fn = /export async function drainRoomWaitingWindows[\s\S]*?\n}/.exec(drain)?.[0] ?? "";
    expect(fn).toMatch(/Math\.min\(12,/);
  });

  it("re-reads the switch PER PIECE (hazard 3), so a disabled room's audio never rides through", () => {
    const fn = /export async function drainRoomWaitingWindows[\s\S]*?\n}/.exec(drain)?.[0] ?? "";
    expect(fn).toMatch(/isTranscriptEnabled\(roomId\)/);
  });

  it("reports engine, characters, seconds and cost per piece (§2.1)", () => {
    expect(drain).toMatch(/out\.cost_usd = asr\.costUsd/);
    expect(drain).toMatch(/out\.transcript_chars = /);
  });

  it("the operator door to it is named for the operator's action, never for the machine", () => {
    // §3 vocabulary: the page never says the name of that machine. The route path an operator's
    // browser hits must not carry it either.
    const ui = code("components", "admin", "BenchRoomsLive.tsx");
    expect(ui).toMatch(/\/api\/admin\/bench\/run-waiting/);
    expect(ui).not.toMatch(/\/api\/admin\/bench\/drain/);
  });
});

// ---------------------------------------------------------------------------
// §2.4 / D32 / P8 — a spare exists only when a second device is reported.
// ---------------------------------------------------------------------------

describe("§2.4 — a spare exists from a chosen device, never from the arrival of a piece", () => {
  it("the operator page derives spare_exists from the reported device, not from backup pieces", () => {
    const agg = code("lib", "admin", "rooms-live.ts");
    // The counts object's spare_exists comes from the listener's spare_device map…
    expect(agg).toMatch(/spare_exists: spareDeviceByRoom\.get\(room\.id\) \?\? false/);
    // …and its own read fails to "no spare reported", never spreading to the no-day alarm.
    expect(agg).toMatch(/spare_device_unavailable/);
  });

  it("the door reports spare_exists from the reported device too (§2.5)", () => {
    const door = code("lib", "mcp", "tools", "bench.ts");
    expect(door).toMatch(/spareExists = listener\?\.spare_device === true/);
  });

  it("the flag rides the poll upsert COALESCEd, so an unreported value never erases a stored one", () => {
    const bc = code("lib", "bench-commands.ts");
    expect(bc).toMatch(/spare_device = COALESCE\(EXCLUDED\.spare_device, bench_listener\.spare_device\)/);
    // Only a literal true is a device; the browser kiosk never sends it.
    const route = code("app", "api", "bench", "commands", "route.ts");
    expect(route).toMatch(/spareDeviceRaw === "true" \? true/);
  });

  it("the card draws no spare lane, no spare vital and no spare line unless a device exists", () => {
    const ui = code("components", "admin", "BenchRoomsLive.tsx");
    expect(ui).toMatch(/r\.spare_exists && l\.spare \? <LevelBar label="Spare mic"/);
    expect(ui).toMatch(/r\.spare_exists && r\.backup_chunks_today > 0/);
  });
});

// ---------------------------------------------------------------------------
// §2.5 — the door reports the level numbers the screen renders.
// ---------------------------------------------------------------------------

describe("§2.5 — the screen and the door report the same level numbers", () => {
  const door = code("lib", "mcp", "tools", "bench.ts");

  it("the door reports per-microphone level, the learned baseline and the D36/D37 size judgement", () => {
    expect(door).toMatch(/mic_level: micLevelNow/);
    expect(door).toMatch(/spare_level: spareLevelNow/);
    expect(door).toMatch(/mic_size: micSize/);
    expect(door).toMatch(/spare_size: spareSize/);
    // From the SAME shared source the screen reads — readMicSizes, not a second copy.
    expect(door).toMatch(/readMicSizes\(sessionIds\)/);
  });

  it("a NULL level is reported as not-measured, never as zero/silent", () => {
    // levelOf returns null when neither peak nor avg was measured.
    expect(door).toMatch(/return p === null && a === null \? null/);
  });
});
