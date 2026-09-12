/**
 * B2-D4 — the receipt's sentence, from the poll's query string to the fleet row the card renders.
 *
 * ─── WHY THIS IS A ROUTE TEST AND NOT ANOTHER UNIT TEST ────────────────────────────────────────
 * The B1/B1.5 acceptance verdict saw a `swap_failed` row with no reason on it. Every link below was
 * already unit-tested ON ITS OWN — the route's `sp.get`, `cleanPollFields`, the COALESCE, the fleet
 * SELECT — and the sentence still did not reach the screen. So this test drives the real poll
 * route, the real `pollCommands`, the real `applyInstallPoll` and the real fleet route, end to end,
 * and reads the sentence back off the row `deriveRow` hands the card (rule 3: test the wire).
 *
 * THE FAKE DATABASE READS THE REAL SQL. The UPDATE's `col = COALESCE(?, col)` assignments and the
 * SELECT's column list are taken from the statement text itself, so a column dropped from the
 * fleet SELECT, or a value bound to the wrong column, fails here exactly as it would in Postgres.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const store: { rooms: Row[]; installs: Row[] } = { rooms: [], installs: [] };

/**
 * `UPDATE room_install SET a = COALESCE(?, a), b = ?, c = CASE WHEN ?::text = 'x' THEN NULL ELSE c
 * END … WHERE install_id = ? AND … RETURNING …` — each form read off the statement's own text.
 */
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
      // Tier 1 §3: `CASE WHEN ?::text = col THEN NULL ELSE col END` — cleared when the value equals
      // what the column held before this statement (SQL NULL never equals anything).
      const same = new RegExp(`^::text = ${col} THEN NULL ELSE ${col} END`).exec(after);
      if (m && values[k] === m[1]) next[col] = null;
      else if (same && values[k] !== null && values[k] !== undefined && values[k] === row[col]) next[col] = null;
    } else if (raw) {
      next[raw[1]!] = values[k] ?? null;
    }
  }
  // Tier 2 §2.2 — the statement's FROM subquery carries PRE-update values out as prev_*, so the
  // pre-image has to be kept before the assign. Columns are now table-qualified; strip the prefix.
  const before: Row = { ...row };
  Object.assign(row, next);
  const returning = /RETURNING\s+([\w.,\s]+?)\s*$/.exec(strings[strings.length - 1]!);
  const cols = returning ? returning[1]!.split(",").map((c) => c.trim().replace(/^[\w]+\./, "")) : ["install_id"];
  const valueOf = (c: string): unknown => {
    if (c === "prev_assigned_channel") return before.assigned_channel ?? null;
    if (c === "prev_room_id") return before.room_id ?? null;
    return row[c] ?? null;
  };
  return [Object.fromEntries(cols.map((c) => [c, valueOf(c)]))];
}

/** `SELECT a, b, c FROM room_install …` — only the named columns come back, as in Postgres. */
function selectInstalls(text: string): Row[] {
  const cols = /SELECT\s+([\s\S]+?)\s+FROM\s+room_install/.exec(text)![1]!
    .split(",")
    .map((c) => c.trim());
  return store.installs.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
}

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    if (/^UPDATE room_install SET /.test(text)) {
      return Promise.resolve(applyUpdate(strings, values));
    }
    if (/^SELECT id, slug, name, disabled_at FROM room /.test(text)) {
      return Promise.resolve(store.rooms);
    }
    if (/^SELECT .* FROM room_install WHERE install_id = \?/.test(text)) {
      const r = store.installs.find((i) => i.install_id === values[0]);
      const cols = /^SELECT\s+(.+?)\s+FROM/.exec(text)![1]!.split(",").map((c) => c.trim());
      return Promise.resolve(r ? [Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))] : []);
    }
    if (/^SELECT .* FROM room_install ORDER BY/.test(text)) {
      return Promise.resolve(selectInstalls(text));
    }
    // bench_listener, bench_command, app_release: nothing stored, nothing returned.
    return Promise.resolve([]);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});
vi.mock("@/lib/room-auth", () => ({ readRoomClaims: async () => ({ room_id: "room_1" }) }));

process.env.MIGRATION_SECRET = "test-secret";
const commands = await import("@/app/api/bench/commands/route");
const fleet = await import("@/app/api/admin/bench/fleet/route");
const assign = await import("@/app/api/admin/installs/[installId]/assign-channel/route");
const V = await import("@/lib/room-install-view");

const SENTENCE = "the new version did not poll within 180 s; restored 0.1.18";

beforeEach(() => {
  store.rooms = [{ id: "room_1", slug: "home-office-w8fb", name: "Home Office", disabled_at: null }];
  store.installs = [
    {
      install_id: "install_539avu7gqzz5",
      room_id: "room_1",
      created_at: "2026-09-11T00:39:00.000Z",
      enrolled_at: "2026-09-11T00:40:00.000Z",
      session_expires_at: "2027-09-11T00:40:00.000Z",
      launched_by: "launchd",
      mic_state: "authorized",
      launch_agent_loaded: true,
      tape_advancing: false,
      tape_poll_streak: 0,
      update_channel: "test",
      app_version: "0.1.18",
      retired_at: null,
    },
  ];
});

const poll = async (query: Record<string, string>) => {
  const q = new URLSearchParams({ tab_id: "native", install_id: "install_539avu7gqzz5", ...query });
  const req = { nextUrl: new URL(`https://www.evenscribe.app/api/bench/commands?${q}`) };
  const res = await commands.GET(req as never);
  return { status: res.status, json: (await res.json()) as Row };
};

const readRow = async () => {
  const req = new Request("https://www.evenscribe.app/api/admin/bench/fleet", {
    headers: { authorization: "Bearer test-secret" },
  });
  const payload = (await (await fleet.GET(req as never)).json()) as V.FleetPayload;
  const row = payload.rows.find((r) => r.room_id === "room_1")!;
  return { row, view: V.deriveRow({ row, latestRelease: null, nowMs: Date.now() }) };
};

describe("B2-D4 — a swap_failed poll's sentence reaches the fleet row", () => {
  it("stores the receipt's sentence and the card's App cell says it", async () => {
    const { status } = await poll({
      app_version: "0.1.18",
      last_update_result: "swap_failed",
      last_update_version: "0.1.19",
      last_update_error: SENTENCE,
      last_update_at: "2026-09-11T11:33:23Z",
    });
    expect(status).toBe(200);

    const { row, view } = await readRow();
    // The wire as far as the row: route → cleanPollFields → UPDATE → fleet SELECT.
    expect(row.install?.last_update_result).toBe("swap_failed");
    expect(row.install?.last_update_error).toBe(SENTENCE);
    // …and the last link, the one the verdict saw: the words the card renders.
    expect(view.update_failed).toBe(true);
    expect(view.update_note).toContain(
      "The new version did not poll within 180 s; restored 0.1.18.",
    );
  });

  it("keeps saying it on the next poll, which omits the receipt (R3-7)", async () => {
    await poll({ last_update_result: "swap_failed", last_update_error: SENTENCE });
    await poll({ app_version: "0.1.18" });
    const { view } = await readRow();
    expect(view.update_note).toContain("did not poll within 180 s");
  });
});

// ---------------------------------------------------------------------------
// Release B2 on the same wire: D5's response field, and D7/D10 intake
// ---------------------------------------------------------------------------

const DEVICES = JSON.stringify([
  { name: "TONOR TM20 Audio Device", uid: "tonor-tm20-1", is_default: true },
  { name: "C270 HD WEBCAM", uid: "c270-1", is_default: false },
]);

describe("B2-D5 — the poll response carries assigned_channel", () => {
  it("is null on a native poll when nothing is assigned", async () => {
    const { json } = await poll({ app_version: "0.1.19" });
    expect(json.ok).toBe(true);
    expect("assigned_channel" in json).toBe(true);
    expect(json.assigned_channel).toBeNull();
  });

  it("is stable once an admin assigned it", async () => {
    store.installs[0]!.assigned_channel = "stable";
    const { json } = await poll({ app_version: "0.1.19" });
    expect(json.assigned_channel).toBe("stable");
  });

  it("is ABSENT from the browser kiosk's response — a poll with no install_id is unchanged", async () => {
    const req = { nextUrl: new URL("https://www.evenscribe.app/api/bench/commands?tab_id=browser") };
    const json = (await (await commands.GET(req as never)).json()) as Row;
    expect(json.ok).toBe(true);
    expect("assigned_channel" in json).toBe(false);
  });

  it("CLEARS ITSELF once the Mac reports stable — a later hand move to test is never undone", async () => {
    const req = new Request("https://www.evenscribe.app/api/admin/installs/x/assign-channel", {
      method: "POST",
      headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
      body: JSON.stringify({ channel: "stable" }),
    });
    const res = await assign.POST(req as never, {
      params: Promise.resolve({ installId: "install_539avu7gqzz5" }),
    });
    expect(res.status).toBe(200);

    // Still on test: the Mac is told stable, and the card shows the assignment.
    expect((await poll({ update_channel: "test" })).json.assigned_channel).toBe("stable");
    // A poll that says nothing about its channel clears nothing.
    expect((await poll({ app_version: "0.1.20" })).json.assigned_channel).toBe("stable");
    // The Mac reports stable of its own accord: the same round trip is told null…
    expect((await poll({ update_channel: "stable" })).json.assigned_channel).toBeNull();
    // …the row holds null…
    const { row, view } = await readRow();
    expect(row.install?.assigned_channel).toBeNull();
    expect(view.assigned_pending).toBe(false);
    // …and a person later putting the Mac back on test by hand is left there.
    expect((await poll({ update_channel: "test" })).json.assigned_channel).toBeNull();
  });

  it("is not told to a retired install, which gets 409 and nothing else", async () => {
    store.installs[0]!.retired_at = "2026-09-11T12:00:00.000Z";
    store.installs[0]!.assigned_channel = "stable";
    const { status, json } = await poll({ app_version: "0.1.19" });
    expect(status).toBe(409);
    expect("assigned_channel" in json).toBe(false);
  });
});

describe("B2-D7/D10 intake — and a 0.1.19 poll cannot erase what 0.1.20 reported", () => {
  it("stores peak, zero_ratio and the device list, and the row passes them through", async () => {
    await poll({ app_version: "0.1.20", peak: "0.42", zero_ratio: "0.4576", input_devices: DEVICES });
    const { row, view } = await readRow();
    expect(row.install?.peak).toBeCloseTo(0.42);
    expect(view.zero_ratio).toBeCloseTo(0.4576);
    expect(view.input_devices).toEqual(JSON.parse(DEVICES));
  });

  it("a poll that sends none of them — every app below 0.1.20 — leaves them exactly as they were", async () => {
    store.installs[0]!.input_device_name = "TONOR TM20 Audio Device";
    await poll({ app_version: "0.1.20", peak: "0.42", zero_ratio: "0.01", input_devices: DEVICES });
    await poll({ app_version: "0.1.19" }); // 0.1.19's poll: no peak, no zero_ratio, no list, no device name
    const { row } = await readRow();
    expect(row.install?.input_device_name).toBe("TONOR TM20 Audio Device");
    expect(row.install?.peak).toBeCloseTo(0.42);
    expect(row.install?.zero_ratio).toBeCloseTo(0.01);
    expect(row.install?.input_devices).toEqual(JSON.parse(DEVICES));
  });

  it("drops out-of-range and malformed values to 'not reported' rather than storing them", async () => {
    await poll({ peak: "0.5", zero_ratio: "0.2", input_devices: DEVICES });
    await poll({ peak: "1.5", zero_ratio: "-0.1", input_devices: "[{\"name\":\"x\"}]" });
    const { row } = await readRow();
    expect(row.install?.peak).toBeCloseTo(0.5);
    expect(row.install?.zero_ratio).toBeCloseTo(0.2);
    expect(row.install?.input_devices).toEqual(JSON.parse(DEVICES));
  });
});
