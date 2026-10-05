/**
 * lib/encounter-windows/ext-health.ts — every status, proven with fixtures that encode what was measured on 5 Oct 2026.
 *
 * THE CASE. Cardiology rebooted 4 Oct 14:10 IST; macOS discarded the hand-written Chrome policy file, the extension vanished (last ext row
 * 2026-10-04T08:39:27Z) while the tailnet poller kept reporting ok / chrome_running=true for the next 24 h. computeExtHealth must call that `missing`.
 *
 * The rules are PURE (`computeExtHealth`); the loader is exercised with a fake tagged-template db (shape, bound parameters, exclusions). The SELECTs
 * themselves run against a real postgres in tests/unit/fleet-attention-sql.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  computeExtHealth,
  compareExtVersions,
  parseExtVersion,
  versionState,
  summarizeExtHealth,
  isExtHealthExcluded,
  extHealth,
  loadExtHealthInputs,
  EXT_TARGET_VERSION,
  EXT_HEALTH_EXCLUDED_MACHINES,
  type ExtHealthInput,
} from "@/lib/encounter-windows/ext-health";
import type { WindowsDb } from "@/lib/encounter-windows/db";

const NOW = Date.parse("2026-10-05T10:00:00.000Z");
const ago = (sec: number): string => new Date(NOW - sec * 1000).toISOString();
const MIN = 60;

/** A healthy, current-build machine; override what the case changes. */
const mk = (over: Partial<ExtHealthInput> = {}): ExtHealthInput => ({
  machine: "EHRC-ECHOs-Mac-mini",
  room_id: "room_cardio",
  room_name: "Cardiology OPD",
  last_ext: { ts: ago(20), event: "heartbeat", reason: null },
  ext_version: EXT_TARGET_VERSION,
  poller: { ts: ago(30), state: "ok", chrome_running: true, console_user: "console-a" },
  behind_since: null,
  ...over,
});
const one = (over: Partial<ExtHealthInput> = {}, now = NOW) => computeExtHealth([mk(over)], now)[0]!;

describe("version comparison — dotted integers, never strings", () => {
  it("target is 0.1.1.39", () => expect(EXT_TARGET_VERSION).toBe("0.1.1.39"));

  it("compares numerically part by part", () => {
    expect(compareExtVersions("0.1.0.9", "0.1.0.40")).toBeLessThan(0); // lexically '9' > '4'
    expect(compareExtVersions("0.1.0.40", "0.1.1.39")).toBeLessThan(0);
    expect(compareExtVersions("0.1.1.100", "0.1.1.39")).toBeGreaterThan(0); // lexically '1' < '3'
    expect(compareExtVersions("0.1.1.39", "0.1.1.39")).toBe(0);
    expect(compareExtVersions("0.2", "0.1.9.9")).toBeGreaterThan(0);
  });

  it("missing trailing parts read as zero", () => {
    expect(compareExtVersions("0.1.1.39.0", "0.1.1.39")).toBe(0);
    expect(compareExtVersions("0.1.1", "0.1.1.0")).toBe(0);
    expect(compareExtVersions("0.1.1", "0.1.1.39")).toBeLessThan(0);
  });

  it("garbage does not parse", () => {
    for (const bad of ["", "abc", "0.1.x", "0..1", "v0.1.1", "0.1.1.39-beta", "1234567.1", "0.1.1.39.1.1.1"]) expect(parseExtVersion(bad), bad).toBeNull();
    expect(compareExtVersions("abc", "0.1.1.39")).toBeNull();
    expect(parseExtVersion(" 0.1.0.36 ")).toEqual([0, 1, 0, 36]);
    expect(parseExtVersion(null)).toBeNull();
  });

  it("version_state: current at and above the target, behind below it, unknown when absent or unparseable", () => {
    expect(versionState("0.1.1.39")).toBe("current");
    expect(versionState("0.1.2.0")).toBe("current");
    expect(versionState("0.1.0.36")).toBe("behind");
    expect(versionState(null)).toBe("unknown");
    expect(versionState("junk")).toBe("unknown");
  });
});

describe("status — ok", () => {
  it("a current extension heartbeating 20 s ago on a reachable Mac", () => {
    const r = one();
    expect(r).toMatchObject({
      machine: "EHRC-ECHOs-Mac-mini",
      room_id: "room_cardio",
      room_name: "Cardiology OPD",
      status: "ok",
      ext_age_s: 20,
      ext_version: "0.1.1.39",
      version_state: "current",
      behind_since: null,
      poller: { ok: true, chrome_running: true, console_user: "console-a", age_s: 30 },
    });
    expect(r.last_ext_ts).toBe(ago(20));
  });

  it("an unparseable or absent version on a live extension is ok, not behind", () => {
    expect(one({ ext_version: null })).toMatchObject({ status: "ok", version_state: "unknown" });
    expect(one({ ext_version: "dev-build" })).toMatchObject({ status: "ok", version_state: "unknown" });
  });

  it("ANY ext event proves life, not only a heartbeat (an `active` 2 min ago)", () => {
    expect(one({ last_ext: { ts: ago(2 * MIN), event: "active", reason: null } }).status).toBe("ok");
  });

  it("the 10-minute edge: 9 min 59 s is alive, 10 min 00 s is not", () => {
    expect(one({ last_ext: { ts: ago(10 * MIN - 1), event: "heartbeat", reason: null } }).status).toBe("ok");
    expect(one({ last_ext: { ts: ago(10 * MIN), event: "heartbeat", reason: null } }).status).toBe("missing");
  });

  it("Chrome not running and no extension events: nothing is expected of the extension (documented gap) — the row still shows chrome_running=false", () => {
    const r = one({ last_ext: { ts: ago(3 * 3600), event: "heartbeat", reason: null }, poller: { ts: ago(20), state: "ok", chrome_running: false, console_user: null } });
    expect(r.status).toBe("ok");
    expect(r.poller.chrome_running).toBe(false);
  });
});

describe("status — missing (the 4 Oct Cardiology case)", () => {
  const asOf = Date.parse("2026-10-05T09:52:05.000Z");
  const cardiology = mk({
    last_ext: { ts: "2026-10-04T08:39:27.360Z", event: "active", reason: null },
    ext_version: "0.1.0.36",
    poller: { ts: "2026-10-05T09:52:05.000Z", state: "ok", chrome_running: true, console_user: "console-a" },
  });

  it("poller ok + chrome_running + last extension row ~25 h ago + no tab_closed logout = missing", () => {
    const [r] = computeExtHealth([cardiology], asOf);
    expect(r).toMatchObject({ status: "missing", ext_version: "0.1.0.36", version_state: "behind", ext_age_s: 90_758, behind_since: null });
    expect(r!.poller).toMatchObject({ ok: true, chrome_running: true, age_s: 0 });
  });

  it("missing outranks behind: a stale extension below target is `missing`, not `behind`", () => {
    expect(one({ ext_version: "0.1.0.21", last_ext: { ts: ago(2 * 3600), event: "heartbeat", reason: null } }).status).toBe("missing");
  });

  it("a machine the extension has never reported on (no row in the look-back) is missing, with no age", () => {
    const r = one({ last_ext: null, ext_version: null });
    expect(r).toMatchObject({ status: "missing", ext_age_s: null, last_ext_ts: null, version_state: "unknown" });
  });

  it("a logout with another reason, or a non-logout event after tab_closed, does not explain the silence", () => {
    expect(one({ last_ext: { ts: ago(30 * MIN), event: "logout", reason: "idle_timeout" } }).status).toBe("missing");
    expect(one({ last_ext: { ts: ago(30 * MIN), event: "logout", reason: null } }).status).toBe("missing");
    expect(one({ last_ext: { ts: ago(30 * MIN), event: "idle", reason: "tab_closed" } }).status).toBe("missing");
  });

  it("chrome_running unknown (null) is not proof Chrome is up: not missing", () => {
    expect(one({ last_ext: null, poller: { ts: ago(20), state: "ok", chrome_running: null, console_user: null } }).status).toBe("ok");
  });
});

describe("status — no_tab (the extension is alive, no Pulse tab)", () => {
  it("a tab_closed logout 30 min ago is no_tab", () => {
    expect(one({ last_ext: { ts: ago(30 * MIN), event: "logout", reason: "tab_closed" } })).toMatchObject({ status: "no_tab", ext_age_s: 1800 });
  });

  it("a reason set that includes tab_closed counts", () => {
    expect(one({ last_ext: { ts: ago(30 * MIN), event: "logout", reason: "tab_closed,absent_401" } }).status).toBe("no_tab");
  });

  it("the 2-hour edge: 1 h 59 m 59 s is no_tab, 2 h is missing", () => {
    expect(one({ last_ext: { ts: ago(2 * 3600 - 1), event: "logout", reason: "tab_closed" } }).status).toBe("no_tab");
    expect(one({ last_ext: { ts: ago(2 * 3600), event: "logout", reason: "tab_closed" } }).status).toBe("missing");
  });

  it("just under 10 minutes the extension is plainly alive (ok), whatever the logout says", () => {
    expect(one({ last_ext: { ts: ago(5 * MIN), event: "logout", reason: "tab_closed" } }).status).toBe("ok");
  });
});

describe("status — behind", () => {
  it("version 0.1.0.36 against target 0.1.1.39, alive = behind, and carries when the run began", () => {
    const r = one({ ext_version: "0.1.0.36", behind_since: ago(5 * 3600) });
    expect(r).toMatchObject({ status: "behind", version_state: "behind", ext_version: "0.1.0.36", behind_since: ago(5 * 3600) });
  });

  it("a version above the target is current", () => expect(one({ ext_version: "0.1.2.0" })).toMatchObject({ status: "ok", version_state: "current" }));

  it("behind_since is only reported while the status is behind", () => {
    expect(one({ ext_version: "0.1.1.39", behind_since: ago(3600) }).behind_since).toBeNull();
  });
});

describe("status — offline", () => {
  it("poller unreachable", () => {
    const r = one({ poller: { ts: ago(30), state: "unreachable", chrome_running: null, console_user: null } });
    expect(r.status).toBe("offline");
    expect(r.poller.ok).toBe(false);
  });

  it("no poller row at all", () => {
    const r = one({ poller: null });
    expect(r).toMatchObject({ status: "offline", poller: { ok: false, chrome_running: null, console_user: null, age_s: null } });
  });

  it("a poller row older than 5 minutes: 4 min 59 s is fresh, 5 min 01 s is offline", () => {
    expect(one({ poller: { ts: ago(5 * MIN - 1), state: "ok", chrome_running: true, console_user: null } }).poller.ok).toBe(true);
    expect(one({ poller: { ts: ago(5 * MIN + 1), state: "ok", chrome_running: true, console_user: null } }).status).toBe("offline");
  });

  it("offline outranks every extension finding: a silent extension on a Mac we cannot see is not `missing`", () => {
    expect(one({ last_ext: null, poller: { ts: ago(30), state: "unreachable", chrome_running: true, console_user: null } }).status).toBe("offline");
    expect(one({ ext_version: "0.1.0.1", poller: null }).status).toBe("offline");
  });
});

describe("exclusions — Home Office, ORB3, ORB2 never appear", () => {
  const spellings = ["Vinays-Mac-mini", "Vinay’s Mac mini", "ORBOX3", "orbox3", "vinay-orb2", "VINAY-ORB2"];

  it("the list names the three no-extension machines", () => {
    expect([...EXT_HEALTH_EXCLUDED_MACHINES].sort()).toEqual(["ORBOX3", "Vinays-Mac-mini", "vinay-orb2"]);
  });

  it("every hostname spelling is excluded; the clinic Macs are not", () => {
    for (const s of spellings) expect(isExtHealthExcluded(s), s).toBe(true);
    for (const s of ["EHRC-ECHOs-Mac-mini", "EHRC-CONSUL2’s Mac mini (2)", "EHRC-AUDIOMETRYs-Mac-mini", "EHRC-DISCUSSIONs-Mac-mini"]) expect(isExtHealthExcluded(s), s).toBe(false);
  });

  it("an excluded machine produces no row even when it is silent on a reachable Mac with Chrome running", () => {
    const silent = (machine: string) => mk({ machine, room_id: `room_${machine}`, last_ext: null, ext_version: null });
    const rows = computeExtHealth([...spellings.map(silent), mk()], NOW);
    expect(rows.map((r) => r.machine)).toEqual(["EHRC-ECHOs-Mac-mini"]);
    expect(summarizeExtHealth(rows).total).toBe(1);
  });
});

describe("summarizeExtHealth", () => {
  it("counts every status, all keys present", () => {
    expect(summarizeExtHealth([])).toEqual({ ok: 0, no_tab: 0, missing: 0, behind: 0, offline: 0, total: 0 });
    const rows = computeExtHealth(
      [
        mk({ machine: "m1" }),
        mk({ machine: "m2", ext_version: "0.1.0.36" }),
        mk({ machine: "m3", ext_version: "0.1.0.36" }),
        mk({ machine: "m4", last_ext: null }),
        mk({ machine: "m5", last_ext: { ts: ago(30 * MIN), event: "logout", reason: "tab_closed" } }),
        mk({ machine: "m6", poller: null }),
      ],
      NOW,
    );
    expect(summarizeExtHealth(rows)).toEqual({ ok: 1, no_tab: 1, missing: 1, behind: 2, offline: 1, total: 6 });
  });
});

// ---------------------------------------------------------------------------
// The loader, with a fake tagged-template db.
// ---------------------------------------------------------------------------

type Q = { text: string; vals: unknown[] };
function fakeDb(responder: (q: Q) => unknown) {
  const issued: Q[] = [];
  const tag = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q: Q = { text: strings.join("?"), vals };
    issued.push(q);
    return Object.assign(q, { then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(responder(q)).then(res, rej) });
  }) as unknown as WindowsDb;
  return { db: tag, issued };
}

const ROOMS = [
  { room_id: "room_cardio", room_name: "Cardiology OPD", hostname: "EHRC-ECHO’s Mac mini" },
  { room_id: "room_opd5", room_name: "OPD 5", hostname: "EHRC-CONSUL5’s Mac mini" },
  { room_id: "room_home", room_name: "Home Office", hostname: "Vinay’s Mac mini" },
  { room_id: "room_orb3", room_name: "ORB3", hostname: "ORBOX3" },
  { room_id: "room_orb2", room_name: "ORB2", hostname: "vinay-orb2" },
];

describe("loadExtHealthInputs / extHealth", () => {
  const eventRows = [
    // Cardiology: poller ok, Chrome up, extension silent since 4 Oct, on 0.1.0.36 — MISSING.
    { machine: "EHRC-ECHOs-Mac-mini", ext_event: "active", ext_ts: "2026-10-04T08:39:27.360Z", ext_reason: null, ver: "0.1.0.36", poller_ts: ago(30), poller_state: "ok", chrome: "true", console_user: "console-a" },
    // OPD 5: alive, on 0.1.0.33 — BEHIND.
    { machine: "EHRC-CONSUL5s-Mac-mini", ext_event: "heartbeat", ext_ts: ago(10), ext_reason: null, ver: "0.1.0.33", poller_ts: ago(30), poller_state: "ok", chrome: "true", console_user: "console-b" },
  ];
  const responder = (q: Q): unknown => {
    if (/FROM room_install/.test(q.text)) return ROOMS;
    if (/LEFT JOIN LATERAL/.test(q.text)) return eventRows;
    if (/min\(p\.ts\)/.test(q.text)) return [{ machine: "EHRC-CONSUL5s-Mac-mini", since: ago(4 * 3600) }];
    return [];
  };

  it("reads the rooms, drops the excluded machines BEFORE any presence read, and returns one row per presence machine", async () => {
    const { db, issued } = fakeDb(responder);
    const rows = await extHealth(db, { asOf: NOW });
    expect(rows.map((r) => `${r.room_name}:${r.status}`)).toEqual(["Cardiology OPD:missing", "OPD 5:behind"]);
    const presence = issued.find((q) => /LEFT JOIN LATERAL/.test(q.text))!;
    const machinesJson = String(presence.vals[0]);
    expect(machinesJson).toContain("EHRC-ECHOs-Mac-mini");
    for (const banned of ["Vinay", "ORBOX3", "orb2"]) expect(machinesJson).not.toContain(banned);
    expect(rows[1]).toMatchObject({ behind_since: ago(4 * 3600), version_state: "behind" });
  });

  it("all values are BOUND parameters (no value text in the SQL), the reads are bounded by asOf, and nothing writes", async () => {
    const { db, issued } = fakeDb(responder);
    await extHealth(db, { asOf: NOW });
    for (const q of issued) {
      expect(q.text).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i);
      expect(q.text).not.toContain("EHRC-");
      expect(q.text).not.toContain("2026-10");
    }
    const presence = issued.find((q) => /LEFT JOIN LATERAL/.test(q.text))!;
    expect(presence.vals).toContain(new Date(NOW).toISOString());
    expect(presence.vals).toContain(new Date(NOW - 14 * 86_400_000).toISOString());
  });

  it("the behind-since read runs ONLY for machines that are alive and behind right now (not for the missing one, not when all are current)", async () => {
    const a = fakeDb(responder);
    await extHealth(a.db, { asOf: NOW });
    const since = a.issued.filter((q) => /min\(p\.ts\)/.test(q.text));
    expect(since).toHaveLength(1);
    expect(String(since[0]!.vals[0])).toContain("EHRC-CONSUL5s-Mac-mini");
    expect(String(since[0]!.vals[0])).not.toContain("EHRC-ECHOs-Mac-mini");
    expect(since[0]!.vals.find((v) => Array.isArray(v))).toEqual([0, 1, 1, 39]);

    const b = fakeDb((q) => (/LEFT JOIN LATERAL/.test(q.text) ? [{ ...eventRows[1]!, ver: "0.1.1.39" }] : /FROM room_install/.test(q.text) ? ROOMS : []));
    await extHealth(b.db, { asOf: NOW });
    expect(b.issued.filter((q) => /min\(p\.ts\)/.test(q.text))).toHaveLength(0);
  });

  it("passed rooms are used as given (no room_install read); an all-excluded fleet reads nothing", async () => {
    const a = fakeDb(responder);
    await extHealth(a.db, { asOf: NOW, rooms: [ROOMS[0]!] });
    expect(a.issued.some((q) => /FROM room_install/.test(q.text))).toBe(false);
    const b = fakeDb(responder);
    expect(await extHealth(b.db, { asOf: NOW, rooms: ROOMS.slice(2) })).toEqual([]);
    expect(b.issued).toHaveLength(0);
  });

  it("maps poller fields: chrome 'true'/'false'/absent, state, console user; a machine with no rows at all is offline", async () => {
    const { db } = fakeDb((q) =>
      /LEFT JOIN LATERAL/.test(q.text)
        ? [{ machine: "EHRC-ECHOs-Mac-mini", ext_event: null, ext_ts: null, ext_reason: null, ver: null, poller_ts: ago(10), poller_state: "ok", chrome: "false", console_user: null }]
        : [],
    );
    const inputs = await loadExtHealthInputs(db, new Date(NOW), [ROOMS[0]!, ROOMS[1]!]);
    expect(inputs[0]).toMatchObject({ machine: "EHRC-ECHOs-Mac-mini", last_ext: null, ext_version: null, poller: { state: "ok", chrome_running: false, console_user: null } });
    expect(inputs[1]).toMatchObject({ machine: "EHRC-CONSUL5s-Mac-mini", last_ext: null, poller: null });
    const rows = computeExtHealth(inputs, NOW);
    expect(rows.map((r) => r.status)).toEqual(["ok", "offline"]);
  });

  it("a bad asOf is refused", async () => {
    const { db } = fakeDb(responder);
    await expect(extHealth(db, { asOf: "nope" })).rejects.toThrow(/bad asOf/);
  });
});
