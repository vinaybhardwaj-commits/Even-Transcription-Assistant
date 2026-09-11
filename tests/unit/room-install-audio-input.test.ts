/**
 * R4-S — `POST /api/admin/installs/{installId}/audio-input` (R4-D5), the two poll fields it reads
 * back (R4-D4 intake), and the card control that fires it — on one fake database that reads the
 * real SQL, the room-install-reason-route convention.
 *
 * ─── THE ROUTE'S PROPERTIES ARE NEGATIVE, LIKE assign-channel's ────────────────────────────────
 *   · no admin cookie and no migration secret → 401, and the database is never touched
 *   · a body that is not `{device_uid?, input_volume?}` with at least one → 400 BAD_ARGS, no SQL
 *   · an unknown, unenrolled or retired install → 404, and NO command row is written
 *   · otherwise exactly one `set_audio_input` row, source `admin`, for the install's own room,
 *     and the answer is the app's ack — or 504 ACK_TIMEOUT carrying the command id
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

type Row = Record<string, unknown>;
const store: { rooms: Row[]; installs: Row[]; commands: Row[] } = { rooms: [], installs: [], commands: [] };
const calls: Array<{ text: string; values: unknown[] }> = [];
/** What the fake app does with a command the moment it lands. Null = it never acks. */
let app: ((cmd: Row) => void) | null = null;
let fault: Error | null = null;
const waitCalls: Array<{ id: string; timeoutMs?: number }> = [];

function applyUpdate(strings: TemplateStringsArray, values: unknown[]): Row[] {
  const where = strings.findIndex((s) => /WHERE\s+install_id\s*=\s*$/.test(s));
  const id = values[where];
  const row = store.installs.find((r) => r.install_id === id && !r.retired_at);
  if (!row) return [];
  const next: Row = { ...row };
  for (let k = 0; k < values.length; k++) {
    if (k === where) continue;
    const before = strings[k]!;
    const after = strings[k + 1] ?? "";
    const coalesced = /(\w+)\s*=\s*COALESCE\(\s*$/.exec(before);
    const clearedOn = /(\w+)\s*=\s*CASE WHEN\s*$/.exec(before);
    const raw = /(?:,|SET)\s*(\w+)\s*=\s*$/.exec(before);
    if (coalesced) {
      if (values[k] !== null && values[k] !== undefined) next[coalesced[1]!] = values[k];
    } else if (clearedOn) {
      const col = clearedOn[1]!;
      const m = new RegExp(`^::text = '(\\w+)' THEN NULL ELSE ${col} END`).exec(after);
      if (m && values[k] === m[1]) next[col] = null;
    } else if (raw) {
      next[raw[1]!] = values[k] ?? null;
    }
  }
  Object.assign(row, next);
  const returning = /RETURNING\s+([\w,\s]+?)\s*$/.exec(strings[strings.length - 1]!);
  const cols = returning ? returning[1]!.split(",").map((c) => c.trim()) : ["install_id"];
  return [Object.fromEntries(cols.map((c) => [c, row[c] ?? null]))];
}

const pick = (text: string, table: string, r: Row) => {
  const cols = new RegExp(`^SELECT\\s+([\\s\\S]+?)\\s+FROM\\s+${table}`).exec(text)![1]!.split(",").map((c) => c.trim());
  return Object.fromEntries(cols.map((c) => [c, r[c] ?? null]));
};

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    if (fault) return Promise.reject(fault);
    if (/^UPDATE room_install SET /.test(text)) return Promise.resolve(applyUpdate(strings, values));
    if (/^SELECT id, slug, name, disabled_at FROM room /.test(text)) return Promise.resolve(store.rooms);
    if (/^SELECT install_id, room_id, app_version FROM room_install WHERE install_id = \?/.test(text)) {
      // The route's lookup. Its two filters are asserted on the text below; here they are applied.
      const r = store.installs.find((i) => i.install_id === values[0] && i.enrolled_at && !i.retired_at);
      return Promise.resolve(r ? [pick(text, "room_install", r)] : []);
    }
    if (/^SELECT .* FROM room_install WHERE install_id = \?/.test(text)) {
      const r = store.installs.find((i) => i.install_id === values[0]);
      return Promise.resolve(r ? [pick(text, "room_install", r)] : []);
    }
    if (/^SELECT .* FROM room_install ORDER BY/.test(text)) {
      return Promise.resolve(store.installs.map((r) => pick(text, "room_install", r)));
    }
    if (/^INSERT INTO bench_command /.test(text)) {
      const cmd: Row = {
        id: values[0], room_id: values[1], kind: values[2], args: values[3] === null ? null : JSON.parse(String(values[3])),
        status: "pending", source: values[4], result: null, error: null, created_at: new Date().toISOString(), acked_at: null,
      };
      store.commands.push(cmd);
      app?.(cmd);
      return Promise.resolve([]);
    }
    if (/FROM bench_command WHERE id = \?/.test(text)) {
      const c = store.commands.find((x) => x.id === values[0]);
      return Promise.resolve(c ? [c] : []);
    }
    return Promise.resolve([]);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});
vi.mock("@/lib/cookie", () => ({ readAdminCookie: async () => null }));
vi.mock("@/lib/room-auth", () => ({ readRoomClaims: async () => ({ room_id: "room_1" }) }));
// waitForAck is the real one, told not to sleep: the fake app acks inside the INSERT, so the first
// read sees the ack — and a command nobody acks times out at once instead of after 8 s. What the
// route ASKED for is recorded, so the 8 s is still asserted.
vi.mock("@/lib/bench-commands", async (importOriginal) => {
  const o = await importOriginal<typeof import("@/lib/bench-commands")>();
  return {
    ...o,
    waitForAck: (id: string, opts: { timeoutMs?: number } = {}) => {
      waitCalls.push({ id, timeoutMs: opts.timeoutMs });
      return o.waitForAck(id, { timeoutMs: 0, intervalMs: 0, sleep: async () => undefined });
    },
  };
});

process.env.MIGRATION_SECRET = "test-secret";
const route = await import("@/app/api/admin/installs/[installId]/audio-input/route");
const commands = await import("@/app/api/bench/commands/route");
const fleet = await import("@/app/api/admin/bench/fleet/route");
const V = await import("@/lib/room-install-view");
const { ACK_WAIT_MS } = await import("@/lib/bench-bus-constants");
const { FleetTable } = await import("@/components/admin/BenchInstallFleet");

const INSTALL = "install_539avu7gqzz5";
const DEVICES = [
  { name: "TONOR TM20 Audio Device", uid: "tonor-tm20-1", is_default: true },
  { name: "C270 HD WEBCAM", uid: "c270-1", is_default: false },
];

beforeEach(() => {
  calls.length = 0;
  waitCalls.length = 0;
  app = null;
  fault = null;
  store.rooms = [{ id: "room_1", slug: "home-office-w8fb", name: "Home Office", disabled_at: null }];
  store.commands = [];
  store.installs = [
    {
      install_id: INSTALL, room_id: "room_1",
      created_at: "2026-09-11T00:39:00.000Z", enrolled_at: "2026-09-11T00:40:00.000Z",
      session_expires_at: "2027-09-11T00:40:00.000Z", launched_by: "launchd", mic_state: "authorized",
      launch_agent_loaded: true, tape_advancing: true, tape_poll_streak: 3, update_channel: "test",
      app_version: "0.1.21", input_device_name: "TONOR TM20 Audio Device", input_devices: DEVICES, retired_at: null,
    },
  ];
});

const post = async (body: unknown, opts: { auth?: boolean; id?: string; raw?: string } = {}) => {
  const req = new Request("https://www.evenscribe.app/api/admin/installs/x/audio-input", {
    method: "POST",
    headers: { "content-type": "application/json", ...(opts.auth === false ? {} : { authorization: "Bearer test-secret" }) },
    body: opts.raw ?? JSON.stringify(body),
  });
  const res = await route.POST(req as never, { params: Promise.resolve({ installId: opts.id ?? INSTALL }) });
  return { status: res.status, json: (await res.json()) as Record<string, never>, headers: res.headers };
};
const commandInserts = () => calls.filter((c) => /^INSERT INTO bench_command/.test(c.text));
const ackAs = (status: "acked" | "failed", error: string | null, result: Row) => (cmd: Row) => {
  Object.assign(cmd, { status, error, result, acked_at: new Date().toISOString() });
};

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

describe("R4-D5 — POST …/audio-input", () => {
  it("401 without the admin guard, and never reaches the database", async () => {
    const { status } = await post({ device_uid: "c270-1" }, { auth: false });
    expect(status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("400 BAD_ARGS for every body that is not {device_uid?, input_volume?} with at least one — no SQL", async () => {
    const bad: unknown[] = [
      {}, null, [], "c270-1", 0.5,
      { device_uid: "" }, { device_uid: 7 }, { device_uid: "u".repeat(257) },
      { input_volume: 1.5 }, { input_volume: -0.01 }, { input_volume: "0.5" },
      { device_uid: "c270-1", gain: 1 }, { channel: "stable" },
    ];
    for (const body of bad) {
      const { status, json } = await post(body);
      expect(status, JSON.stringify(body)).toBe(400);
      expect((json as { error: { code: string } }).error.code).toBe("BAD_ARGS");
    }
    expect((await post(null, { raw: "{not json" })).status).toBe(400);
    expect((await post(null, { raw: "" })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("404 for an unknown, an unenrolled or a retired install — and no command row is written", async () => {
    store.installs.push(
      { ...store.installs[0]!, install_id: "install_retired00001", retired_at: "2026-09-10T00:00:00.000Z" },
      { ...store.installs[0]!, install_id: "install_unenrolled01", enrolled_at: null },
    );
    for (const id of ["install_nobody000001", "install_retired00001", "install_unenrolled01"]) {
      const { status, json } = await post({ device_uid: "c270-1" }, { id });
      expect(status, id).toBe(404);
      expect((json as { error: { code: string } }).error.code).toBe("NOT_FOUND");
    }
    expect(commandInserts()).toHaveLength(0);
    // The two filters that make "bound" mean bound are in the lookup's own text.
    const lookup = calls.find((c) => /^SELECT install_id, room_id, app_version FROM room_install/.test(c.text))!;
    expect(lookup.text).toContain("AND enrolled_at IS NOT NULL");
    expect(lookup.text).toContain("AND retired_at IS NULL");
  });

  it("enqueues ONE set_audio_input for the install's room, source admin, and answers with the ack", async () => {
    app = ackAs("acked", null, { ok: true });
    const { status, json, headers } = await post({ device_uid: "c270-1" });
    expect(status).toBe(200);
    expect(headers.get("cache-control")).toBe("no-store");
    const ins = commandInserts();
    expect(ins).toHaveLength(1);
    const id = ins[0]!.values[0] as string;
    expect(ins[0]!.values).toEqual([id, "room_1", "set_audio_input", JSON.stringify({ device_uid: "c270-1" }), "admin"]);
    expect(json).toEqual({ command: { id, status: "acked", result: { ok: true }, error: null } });
    expect(waitCalls).toEqual([{ id, timeoutMs: ACK_WAIT_MS }]);
  });

  it("carries the app's failure through as 200 with the command's own error (the card shows it)", async () => {
    app = ackAs("failed", "volume_not_settable", { ok: false, error: "volume_not_settable" });
    const { status, json } = await post({ input_volume: 0.5 });
    expect(status).toBe(200);
    expect((json as { command: Row }).command).toMatchObject({ status: "failed", error: "volume_not_settable" });
    expect(commandInserts()[0]!.values[3]).toBe(JSON.stringify({ input_volume: 0.5 }));
  });

  it("504 ACK_TIMEOUT when nobody acks, with the command id so the card can look again", async () => {
    app = null;
    const { status, json } = await post({ device_uid: "c270-1", input_volume: 0.25 });
    expect(status).toBe(504);
    const j = json as { error: { code: string; message: string }; command: Row };
    expect(j.error.code).toBe("ACK_TIMEOUT");
    const id = commandInserts()[0]!.values[0];
    expect(j.command).toEqual({ id, status: "pending", result: null, error: null });
    expect(j.error.message).toContain(String(id));
  });

  // ── R4-D11 — an app that cannot decode the kind is never sent it ────────────────────────────
  it("D11: refuses 409 APP_TOO_OLD for 0.1.20 and for a Mac that never reported a version — nothing inserted", async () => {
    for (const v of ["0.1.20", null, "0.1.3", "garbage", ""]) {
      calls.length = 0;
      store.installs[0]!.app_version = v;
      const { status, json } = await post({ device_uid: "c270-1" });
      expect(status, String(v)).toBe(409);
      const err = (json as { error: { code: string; app_version: string | null } }).error;
      expect(err.code).toBe("APP_TOO_OLD");
      expect(err.app_version).toBe(v === "" ? null : v);
      expect(commandInserts()).toHaveLength(0);
    }
  });

  it("D11: inserts for 0.1.21 and anything numerically above it (0.1.100 is above, not below)", async () => {
    app = ackAs("acked", null, { ok: true });
    for (const v of ["0.1.21", "0.1.100", "0.2", "1.0.0"]) {
      calls.length = 0;
      store.installs[0]!.app_version = v;
      const { status } = await post({ input_volume: 0.5 });
      expect(status, v).toBe(200);
      expect(commandInserts()).toHaveLength(1);
    }
  });

  it("answers a store fault as 503 STORE_UNAVAILABLE, never a 500", async () => {
    fault = new Error("connect ECONNREFUSED");
    const { status, json } = await post({ device_uid: "c270-1" });
    expect(status).toBe(503);
    expect((json as { error: { code: string } }).error.code).toBe("STORE_UNAVAILABLE");
  });
});

// ---------------------------------------------------------------------------
// R4-D4 intake — the two poll fields, route → cleanPollFields → UPDATE → fleet SELECT → row
// ---------------------------------------------------------------------------

const poll = async (query: Record<string, string>) => {
  const q = new URLSearchParams({ tab_id: "native", install_id: INSTALL, ...query });
  const res = await commands.GET({ nextUrl: new URL(`https://www.evenscribe.app/api/bench/commands?${q}`) } as never);
  return { status: res.status, json: (await res.json()) as Row };
};
const readRow = async () => {
  const req = new Request("https://www.evenscribe.app/api/admin/bench/fleet", { headers: { authorization: "Bearer test-secret" } });
  const payload = (await (await fleet.GET(req as never)).json()) as V.FleetPayload;
  const row = payload.rows.find((r) => r.room_id === "room_1")!;
  return { row, view: V.deriveRow({ row, latestRelease: null, nowMs: Date.now() }) };
};

describe("R4-D4 intake — input_volume and input_volume_settable", () => {
  it("stores both, and the row passes them through with the card's words", async () => {
    expect((await poll({ app_version: "0.1.21", input_volume: "0.6200", input_volume_settable: "true" })).status).toBe(200);
    const { row, view } = await readRow();
    expect(row.install?.input_volume).toBeCloseTo(0.62);
    expect(row.install?.input_volume_settable).toBe(true);
    expect(view.input_volume).toBeCloseTo(0.62);
    expect(view.input_volume_settable).toBe(true);
    expect(view.volume_text).toBe("62%");
  });

  it("a 0.1.20-shaped poll — neither field — leaves both exactly as they were (COALESCE)", async () => {
    await poll({ app_version: "0.1.21", input_volume: "0.5", input_volume_settable: "true" });
    await poll({ app_version: "0.1.20", peak: "0.3" });
    const { row } = await readRow();
    expect(row.install?.input_volume).toBeCloseTo(0.5);
    expect(row.install?.input_volume_settable).toBe(true);
    const up = calls.filter((c) => /^UPDATE room_install SET /.test(c.text)).pop()!.text;
    expect(up).toMatch(/input_volume\s*=\s*COALESCE\(\?::real, input_volume\)/);
    expect(up).toMatch(/input_volume_settable\s*=\s*COALESCE\(\?::boolean, input_volume_settable\)/);
  });

  it("stores settable=false as false — a measurement, not an absence — and the card says 'not settable'", async () => {
    await poll({ input_volume_settable: "false" });
    const { row, view } = await readRow();
    expect(row.install?.input_volume_settable).toBe(false);
    expect(view.volume_text).toBe("not settable");
  });

  it("drops an out-of-range or malformed volume and a non-boolean flag to 'not reported', never clamps", async () => {
    await poll({ input_volume: "0.4", input_volume_settable: "true" });
    for (const bad of ["1.5", "-0.1", "NaN", "abc", ""]) await poll({ input_volume: bad, input_volume_settable: "yes" });
    const { row } = await readRow();
    expect(row.install?.input_volume).toBeCloseTo(0.4);
    expect(row.install?.input_volume_settable).toBe(true);
  });

  it("reads '—' when the app never reported a volume", async () => {
    const { row, view } = await readRow();
    expect(row.install?.input_volume ?? null).toBeNull();
    expect(view.volume_text).toBe("—");
  });

  it("a 0.1.20 poll still gets its 200 — fields it does not send cannot reject it", async () => {
    const { status, json } = await poll({ app_version: "0.1.20", update_channel: "stable" });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect("assigned_channel" in json).toBe(true);
  });
});

describe("volumeText", () => {
  it("is a whole percentage, 'not settable' when the device refuses, '—' when unreported", () => {
    expect(V.volumeText(0.5, true)).toBe("50%");
    expect(V.volumeText(0, true)).toBe("0%");
    expect(V.volumeText(1, null)).toBe("100%");
    expect(V.volumeText(0.62, false)).toBe("not settable");
    expect(V.volumeText(null, false)).toBe("not settable");
    for (const none of [null, undefined, Number.NaN]) expect(V.volumeText(none, true)).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// R4-D5 — the card control, rendered
// ---------------------------------------------------------------------------

describe("R4-D5 — the card's device select and volume slider", () => {
  const nowMs = Date.parse("2026-09-11T15:00:00.000Z");
  const install = (over: Partial<V.InstallView>): V.InstallView =>
    ({
      install_id: INSTALL, room_id: "room_1", created_at: "2026-09-11T00:39:00.000Z", enrolled_at: "2026-09-11T00:40:00.000Z",
      session_expires_at: "2027-09-11T00:40:00.000Z", launched_by: "launchd", hostname: "MINI", hardware_model: "Mac mini",
      os_version: "macOS 15.7", input_device_name: "TONOR TM20 Audio Device", app_version: "0.1.21", build_sha: "abc1234",
      first_seen_at: "2026-09-11T00:41:00.000Z", last_seen_at: "2026-09-11T14:59:58.000Z", mic_state: "authorized",
      launch_agent_loaded: true, tape_advancing: true, tape_poll_streak: 3, tape_advancing_since: null, never_sleep: true,
      retired_at: null, session_open: true, update_channel: "test", last_update_result: null, last_update_version: null,
      last_update_error: null, last_update_at: null, disk_free_bytes: 180_000_000_000, input_devices: DEVICES,
      ...over,
    }) as V.InstallView;
  const row = (id: string, i: V.InstallView): V.FleetRow => ({
    room_id: id, room_slug: `${id}-slug`, room_name: id, disabled: false, install: { ...i, room_id: id }, pending: null, last_retired: null,
  });
  const render = (rows: V.FleetRow[]) =>
    renderToStaticMarkup(
      React.createElement(FleetTable, {
        fleet: { now: new Date(nowMs).toISOString(), rows, latest_release: null, releases: { stable: null, test: null }, degraded: [], unassigned: [] },
        nowMs, busy: null, onCopy: () => {}, onRetire: () => {}, onAssignStable: () => {}, onSetAudioInput: () => {},
      }),
    );

  it("lists every input, marks the default and the one recording, and shows the volume next to the device", () => {
    const html = render([row("room_a", install({ input_volume: 0.62, input_volume_settable: true }))]);
    expect((html.match(/<select[^>]*data-audio-device/g) ?? []).length).toBe(1);
    expect(html).toMatch(/<option[^>]*value="tonor-tm20-1"[^>]*>TONOR TM20 Audio Device \(default\) · recording<\/option>/);
    expect(html).toMatch(/<option[^>]*value="c270-1"[^>]*>C270 HD WEBCAM<\/option>/);
    expect(html).toMatch(/<option selected="" value="tonor-tm20-1"|<option value="tonor-tm20-1" selected=""/);
    expect(html).toMatch(/data-volume-text[^>]*>62%</);
  });

  it("enables the slider only when the app said the device is settable", () => {
    const html = render([
      row("room_a", install({ input_volume: 0.62, input_volume_settable: true })),
      row("room_b", install({ input_volume: 0.3, input_volume_settable: false })),
      row("room_c", install({ input_volume: null, input_volume_settable: null })),
    ]);
    const sliders = html.match(/<input[^>]*data-audio-volume[^>]*>/g) ?? [];
    expect(sliders).toHaveLength(3);
    expect(sliders.map((s) => /\sdisabled=""/.test(s))).toEqual([false, true, true]);
    expect(sliders.every((s) => /type="range"/.test(s) && /min="0"/.test(s) && /max="100"/.test(s))).toBe(true);
    expect(html).toMatch(/data-volume-text[^>]*>not settable</);
    expect(html).toMatch(/data-volume-text[^>]*>—</);
  });

  it("offers no control on a row with no bound Mac", () => {
    const empty: V.FleetRow = { room_id: "room_z", room_slug: "z", room_name: "Z", disabled: false, install: null, pending: null, last_retired: null };
    const html = render([empty]);
    expect(html).not.toMatch(/data-audio-device|data-audio-volume/);
  });
});
