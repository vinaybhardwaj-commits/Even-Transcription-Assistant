/**
 * lib/kiosk-health-read.ts — the three SELECTs AGAINST A REAL POSTGRES (migration 0126 verbatim, statements sent with BOUND untyped parameters
 * through the s1-pg harness, the way the Neon HTTP driver sends them). The fake-sql tests in kiosk-health-rules.test.ts prove the mapping; this file
 * proves the SQL itself runs, types its parameters, windows on received_at, caps per machine, and that hal_error rows alone count nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { readKioskHealth } from "@/lib/kiosk-health-read";
import { kioskHealthItems } from "@/lib/kiosk-health-rules";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-kiosk-health-read");
const noRecord = (f: string) => readFileSync(f, "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, "");

const M = "EHRC-OPD6s-Mac-mini";
const OTHER = "EHRC-OPD5s-Mac-mini";
const OLD3D = "EHRC-OLD3Ds-Mac-mini";
const OLD8D = "EHRC-OLD8Ds-Mac-mini";
const LOCAL = "EHRC-LOCALs-Mac-mini";
const AS_OF = new Date("2026-10-06T05:30:00.000Z"); // 11:00 IST
const at = (secAgo: number) => new Date(AS_OF.getTime() - secAgo * 1000).toISOString();
let seq = 0;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
function row(machine: string, kind: string, tsAgo: number, payload: unknown, recvAgo: number = tsAgo): string {
  seq += 1;
  return `(${lit(at(recvAgo))}, ${lit(machine)}, 'room_x', 'inst', 'boot1', ${seq}, 'daemon', ${lit(kind)}, ${lit(at(tsAgo))}, ${lit(JSON.stringify(payload))}::jsonb)`;
}
/** A row with explicit received_at / ts / boot_id (absolute ISO times), for the first-tail backfill proof. */
function rowAbs(machine: string, boot: string, kind: string, recvIso: string, payload: unknown, tsIso: string = recvIso): string {
  seq += 1;
  return `(${lit(recvIso)}, ${lit(machine)}, 'room_x', 'inst', ${lit(boot)}, ${seq}, 'daemon', ${lit(kind)}, ${lit(tsIso)}, ${lit(JSON.stringify(payload))}::jsonb)`;
}
function insert(rows: string[]): void {
  pg.exec(`INSERT INTO kiosk_health_events (received_at, machine, room_id, install_id, boot_id, seq, source, kind, ts, payload) VALUES ${rows.join(",\n")};`);
}

describe("REQUIRED PROOF — the kiosk-health SELECTs run against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/kiosk-health-read-sql.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

beforeAll(() => {
  if (!HAVE_DOCKER) return;
  pg.start();
  pg.exec(noRecord("db/migrations/0126_kiosk_health_events.sql"));
  pg.exec(noRecord("db/migrations/0127_kiosk_health_machine_received_idx.sql"));
  const sp = (present: boolean, name: string | null) => ({ devices: [], default_input: name ? { uid: "u", name } : null, default_input_present: present, trigger: "poll" });
  insert([
    // heartbeats: newest by ts wins
    row(M, "heartbeat", 1500, { version: "0.1.4" }),
    row(M, "heartbeat", 800, { version: "0.1.4" }),
    // audio.devices: an ioreg row NEWER than the system_profiler row must not shadow it
    row(M, "audio.devices", 900, sp(false, null)),
    row(M, "audio.devices", 30, { usb_audio: [], usb_added: [], usb_removed: [], audio_engines: [] }),
    // audio.error: one hal_error (never counts), two start failures in the last 10 min, one start failure 20 min ago
    row(M, "audio.error", 50, { class: "hal_error", start_failure: false, detail: "x", process: "coreaudiod" }),
    row(M, "audio.error", 120, { class: "start_failure", start_failure: true, detail: "x", process: "recorder" }),
    row(M, "audio.error", 60, { class: "start_failure", start_failure: true, detail: "x", process: "recorder" }),
    row(M, "audio.error", 1200, { class: "start_failure", start_failure: true, detail: "x", process: "recorder" }),
    // F8: only the JSON boolean true counts, never the string "true"
    row(M, "audio.error", 70, { class: "start_failure", start_failure: "true", detail: "x", process: "recorder" }),
    // power: a backfilled pair (ts 15 h / 14 h old, received seconds ago) plus a live sleep
    row(M, "power.sleep", 15 * 3600, { origin: "pmset_log", domain: "Sleep", message: "m", reason: "Idle Sleep" }, 5),
    row(M, "power.wake", 14 * 3600, { origin: "pmset_log", domain: "Wake", message: "m" }, 5),
    row(M, "power.darkwake", 600, { origin: "iokit", domain: "DarkWake", message: "m", kAESleep: "0x1" }),
    // drift: open then resolved for one field, open for another
    row(M, "drift", 5000, { field: "sleep", expected: 0, actual: 10, change: "initial" }),
    row(M, "drift", 1000, { field: "sleep", expected: 0, actual: 0, change: "resolved", resolved: true }),
    row(M, "drift", 900, { field: "displaysleep", expected: 10, actual: 2, change: "changed", was: 3 }),
    // recorder.log: two signature_mismatch lines, one other line
    row(M, "recorder.log", 8000, { file: "f", line: "room-recorder: update to 0.1.18 stopped: signature_mismatch: a", count: 1, recv_ts: "t", redaction: "none" }),
    row(M, "recorder.log", 700, { file: "f", line: "room-recorder: update to 0.1.18 stopped: signature_mismatch: b", count: 1, recv_ts: "t", redaction: "none" }),
    row(M, "recorder.log", 100, { file: "f", line: "Recording stopped cleanly.", count: 1, recv_ts: "t", redaction: "none" }),
    // outside the 24 h received_at window: must not be seen at all
    row(M, "recorder.log", 25 * 3600, { file: "f", line: "signature_mismatch: ancient", count: 1, recv_ts: "t", redaction: "none" }),
    // a different machine that is not asked for
    row(OTHER, "heartbeat", 10, {}),
    // F3: a machine last seen 3 days ago is still enrolled; one last seen 8 days ago is not
    row(OLD3D, "heartbeat", 3 * 86400, {}, 3 * 86400),
    row(OLD8D, "heartbeat", 8 * 86400, {}, 8 * 86400),
    // F7: the daemon names its Mac in lower case with .local
    row(LOCAL.toLowerCase() + ".local", "heartbeat", 15, {}),
    // received AFTER asOf (clock skew / future): excluded by the upper bound
    row(M, "chrome.alert", -300, { running: false, reason: "not_running" }),
  ]);
});
afterAll(() => { if (HAVE_DOCKER) pg.stop(); });

describe.skipIf(!HAVE_DOCKER)("readKioskHealth against postgres 16", () => {
  it("returns the evidence for the asked machine only, windowed on received_at", async () => {
    const { snapshots: m, ok } = await readKioskHealth(pg.sql as never, [M], AS_OF.toISOString());
    expect(ok).toBe(true);
    expect([...m.keys()]).toEqual([M]);
    const s = m.get(M)!;
    expect(s.enrolled).toBe(true);
    expect(s.last_heartbeat_received_at).toBe(at(800));
    expect(s.last_seen_received_at).toBe(at(5));
    expect(s.last_chrome_alert).toBeNull();
    expect(s.recorder_update_failures_24h.count).toBe(2);
    expect(s.recorder_update_failures_24h.newest_line).toContain("signature_mismatch: b");
  });

  it("audio: system_profiler row is not shadowed by a newer ioreg row; hal_error never counts; start failures counted in the last 10 min only", async () => {
    const s = (await readKioskHealth(pg.sql as never, [M], AS_OF.toISOString())).snapshots.get(M)!;
    expect(s.last_audio_devices).toMatchObject({ default_input_present: false, default_input_name: null });
    expect(s.audio_start_failures_10m).toBe(2); // the string "true" row at 70 s and the 20-minute-old row are not counted
    expect(s.audio_start_failure_newest_ts).toBe(at(60));
  });

  it("power: the 12 h list includes backfilled rows (received now), ordered by ts; the live darkwake is newest", async () => {
    const s = (await readKioskHealth(pg.sql as never, [M], AS_OF.toISOString())).snapshots.get(M)!;
    expect(s.power_events.map((e) => e.kind)).toEqual(["power.sleep", "power.wake", "power.darkwake"]);
    expect(s.last_power).toMatchObject({ kind: "power.darkwake", kAESleep: "0x1" });
    expect(s.power_events[0]).toMatchObject({ reason: "Idle Sleep" });
  });

  it("drift: latest row per field, a resolved row closes its field", async () => {
    const s = (await readKioskHealth(pg.sql as never, [M], AS_OF.toISOString())).snapshots.get(M)!;
    expect(s.last_drift_by_field.sleep).toMatchObject({ change: "resolved", resolved: true });
    expect(s.last_drift_by_field.displaysleep).toMatchObject({ expected: "10", actual: "2" });
  });

  it("F3 enrolment is 'seen in the last 7 days': a 3-day-old machine is enrolled with last_seen, an 8-day-old one does not appear", async () => {
    const { snapshots } = await readKioskHealth(pg.sql as never, [OLD3D, OLD8D], AS_OF.toISOString());
    expect([...snapshots.keys()]).toEqual([OLD3D]);
    expect(snapshots.get(OLD3D)).toMatchObject({ enrolled: true, last_seen_received_at: at(3 * 86400), last_heartbeat_received_at: null });
  });

  it("F7 a lower-case '.local' spelling in the table is found and mapped to the canonical machine", async () => {
    const { snapshots } = await readKioskHealth(pg.sql as never, [LOCAL], AS_OF.toISOString());
    expect(snapshots.get(LOCAL)).toMatchObject({ enrolled: true, last_heartbeat_received_at: at(15) });
  });

  it("end to end: the rules read the real rows — asleep (darkwake after the backfilled wake), audio dead, drift on displaysleep, recorder update failing", async () => {
    const { snapshots: snaps } = await readKioskHealth(pg.sql as never, [M], AS_OF.toISOString());
    const items = kioskHealthItems(snaps, new Map(), AS_OF.toISOString(), true);
    expect(items.map((i) => i.kind).sort()).toEqual(["audio_dead", "config_drift", "kiosk_asleep", "recorder_update_failing"]);
    expect(items.find((i) => i.kind === "config_drift")!.detail).toContain("displaysleep: 10 → 2");
    expect(items.find((i) => i.kind === "config_drift")!.detail).not.toContain("sleep: 0");
  });

  it("caps power events at 50 and drift rows at 100 per machine, newest kept", async () => {
    const rows: string[] = [];
    for (let i = 0; i < 60; i += 1) rows.push(row(OTHER, i % 2 ? "power.wake" : "power.sleep", 100 + i, { origin: "iokit", domain: "d", message: "m" }));
    for (let i = 0; i < 120; i += 1) rows.push(row(OTHER, "drift", 100 + i, { field: `f${i}`, expected: 1, actual: 2, change: "changed" }));
    insert(rows);
    const s = (await readKioskHealth(pg.sql as never, [OTHER], AS_OF.toISOString())).snapshots.get(OTHER)!;
    expect(s.power_events.length).toBe(50);
    expect(Object.keys(s.last_drift_by_field).length).toBe(100);
    expect(s.last_drift_by_field.f0).toBeDefined();
    expect(s.last_drift_by_field.f119).toBeUndefined();
  });

  it("every statement is machine-scoped (machine = ANY) when run against the real driver shape", async () => {
    // Sanity on the shape only: the statement text must carry machine = ANY and both bounds; the planner is free to pick any index.
    const rec: string[] = [];
    const wrap = (s: TemplateStringsArray, ...v: unknown[]) => { rec.push(s.join("?")); return pg.sql(s, ...v); };
    await readKioskHealth(wrap as never, [M], AS_OF.toISOString());
    expect(rec.length).toBe(4);
    for (const q of rec) expect(q).toMatch(/machine\s*=\s*ANY\(/);
  });
});

// ---------------------------------------------------------------------------
// R17 first-tail backfill (fix C): recorder.log rows received within 10 min after the SAME boot_id's start heartbeat are historical launchd.log lines
// ---------------------------------------------------------------------------
describe.skipIf(!HAVE_DOCKER)("recorder.log signature_mismatch rows exclude the daemon's first-tail backfill", () => {
  const AS = "2026-10-06T05:50:00.000Z";
  const Z = (hhmm: string) => `2026-10-06T${hhmm}:00.000Z`;
  const sigLine = (n: string) => ({ file: "launchd.log", line: `room-recorder: update to 0.1.18 stopped: signature_mismatch: ${n}`, count: 1, recv_ts: "2026-10-05T10:00:00Z", redaction: "none" });
  const START = { event: "start", version: "0.1.4" };
  const CARDIO = "EHRC-CARDIOLOGYs-Mac-mini";
  const DIET = "EHRC-DIETARYs-Mac-mini";
  const WIN = "EHRC-WINDOWs-Mac-mini"; // row 3 min after the start beat, and one 15 min after
  const FAR = "EHRC-FARs-Mac-mini"; // only a row 15 min after
  const NEAR = "EHRC-NEARs-Mac-mini"; // only a row 3 min after
  const UNK = "EHRC-UNKNOWNBOOTs-Mac-mini"; // start beat belongs to another boot_id
  const NOSTART = "EHRC-NOSTARTs-Mac-mini"; // heartbeats but none with event=start
  const LIVE = "EHRC-LIVEs-Mac-mini"; // F5: line timestamps decide inside the window
  const read = async (m: string) => (await readKioskHealth(pg.sql as never, [m], AS)).snapshots.get(m)!;

  beforeAll(() => {
    insert([
      // the 6 Oct Cardiology / Dietary false alarm: boot beat 05:40Z, historical lines shipped at 05:41Z
      rowAbs(CARDIO, "bootC", "heartbeat", Z("05:40"), START),
      rowAbs(CARDIO, "bootC", "recorder.log", Z("05:41"), sigLine("old a")),
      rowAbs(CARDIO, "bootC", "recorder.log", "2026-10-06T05:41:01.000Z", sigLine("old b")),
      rowAbs(DIET, "bootD", "heartbeat", Z("05:40"), START),
      rowAbs(DIET, "bootD", "recorder.log", Z("05:41"), sigLine("old c")),
      // one machine, one boot: +3 min is backfill (excluded), +15 min is a live failure (kept)
      rowAbs(WIN, "bootW", "heartbeat", Z("05:00"), START),
      rowAbs(WIN, "bootW", "recorder.log", Z("05:03"), sigLine("backfill")),
      rowAbs(WIN, "bootW", "recorder.log", Z("05:15"), sigLine("live")),
      rowAbs(FAR, "bootF", "heartbeat", Z("05:00"), START),
      rowAbs(FAR, "bootF", "recorder.log", Z("05:15"), sigLine("live far")),
      rowAbs(NEAR, "bootN", "heartbeat", Z("05:00"), START),
      rowAbs(NEAR, "bootN", "recorder.log", Z("05:03"), sigLine("backfill near")),
      // a start beat of a DIFFERENT boot_id does not shield this boot's row; no start beat known at all keeps the row
      rowAbs(UNK, "bootOther", "heartbeat", Z("05:00"), START),
      rowAbs(UNK, "bootU", "recorder.log", Z("05:03"), sigLine("unknown boot")),
      rowAbs(NOSTART, "bootS", "heartbeat", Z("05:00"), { version: "0.1.4" }),
      rowAbs(NOSTART, "bootS", "recorder.log", Z("05:03"), sigLine("no start beat")),
      // F5: live failure 5 min after the beat whose line is stamped AFTER the beat is kept; a historical stamped line in the window is excluded;
      // a line stamped only 2 min before the beat (< 10 min) is kept
      rowAbs(LIVE, "bootL", "heartbeat", Z("05:00"), START),
      rowAbs(LIVE, "bootL", "recorder.log", Z("05:05"), { ...sigLine("live"), line: "2026-10-06T05:04:30Z room-recorder: update to 0.1.18 stopped: signature_mismatch: live" }),
      rowAbs(LIVE, "bootL", "recorder.log", Z("05:03"), { ...sigLine("hist"), line: "2026-10-05T10:00:00Z room-recorder: update to 0.1.18 stopped: signature_mismatch: hist" }),
      rowAbs(LIVE, "bootL", "recorder.log", Z("05:02"), { ...sigLine("near"), line: "2026-10-06T04:58:00Z room-recorder: update to 0.1.18 stopped: signature_mismatch: near" }),
    ]);
  });

  it("a row 3 min after the start beat is excluded; a row 15 min after is included", async () => {
    expect((await read(NEAR)).recorder_update_failures_24h.count).toBe(0);
    const far = await read(FAR);
    expect(far.recorder_update_failures_24h.count).toBe(1);
    expect(far.recorder_update_failures_24h.newest_line).toContain("live far");
    const w = await read(WIN);
    expect(w.recorder_update_failures_24h.count).toBe(1);
    expect(w.recorder_update_failures_24h.newest_line).toContain("live");
    expect(w.recorder_update_failures_24h.newest_line).not.toContain("backfill");
  });

  it("a row whose boot_id has no start heartbeat is included (other boot's beat, or no event=start heartbeat at all)", async () => {
    expect((await read(UNK)).recorder_update_failures_24h.count).toBe(1);
    expect((await read(NOSTART)).recorder_update_failures_24h.count).toBe(1);
  });

  it("F5 a live signature_mismatch 5 min after the start beat with a line stamped after the beat is kept; a historical stamped line and one 2 min before the beat: historical excluded, near kept", async () => {
    const f = (await read(LIVE)).recorder_update_failures_24h;
    expect(f.count).toBe(2);
    expect(f.newest_line).toContain("signature_mismatch: live");
  });

  it("chrome.profile history (24 h, newest first, capped at 300 per machine) and ext_installed come back from the real SELECTs", async () => {
    const P = "EHRC-PROFILEs-Mac-mini";
    const rows: string[] = [];
    for (let i = 0; i < 320; i += 1) {
      const recv = new Date(Date.parse(AS) - (300 + i * 240) * 1000).toISOString();
      rows.push(rowAbs(P, "bootP", "chrome.profile", recv, { running: true, last_used: "Profile 1", active: ["Profile 1"], guest: false, ext: { "Profile 1": [] }, presence_ok: i < 310 ? false : true }));
    }
    insert(rows);
    const s = await read(P);
    expect(s.chrome_profile_history.length).toBe(300);
    expect(Date.parse(s.chrome_profile_history[0]!.ts)).toBeGreaterThan(Date.parse(s.chrome_profile_history[299]!.ts));
    expect(s.chrome_profile_history[0]!.ts).toBe(new Date(Date.parse(AS) - 300 * 1000).toISOString());
    expect(s.last_chrome_profile).toMatchObject({ presence_ok: false, ext_installed: false, last_used: "Profile 1" });
  });

  it("the Cardiology / Dietary fixture (start beat 05:40Z, recorder.log rows 05:41Z) raises no R17", async () => {
    const snaps = new Map([...(await readKioskHealth(pg.sql as never, [CARDIO, DIET], AS)).snapshots]);
    expect([...snaps.keys()].sort()).toEqual([CARDIO, DIET].sort());
    for (const s of snaps.values()) expect(s.recorder_update_failures_24h.count).toBe(0);
    const items = kioskHealthItems(snaps, new Map(), AS, true);
    expect(items.filter((i) => i.kind === "recorder_update_failing")).toEqual([]);
  });
});
