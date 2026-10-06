/**
 * lib/encounter-windows/ext-health.ts — every status, proven with fixtures that encode what was measured on 5 Oct 2026.
 *
 * THE CASE. Cardiology rebooted 4 Oct 14:10 IST; macOS discarded the hand-written Chrome policy file, the extension vanished (last ext row
 * 2026-10-04T08:39:27Z) while the tailnet poller kept reporting ok / chrome_running=true for the next 24 h. computeExtHealth must call that `missing`.
 *
 * The rules are PURE (`computeExtHealth`); the loader is exercised with a fake tagged-template db (shape, bound parameters, exclusions). The SELECTs
 * themselves run against a real postgres in tests/unit/fleet-attention-sql.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
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

});

describe("status — no_chrome (poller ok, chrome_running=false)", () => {
  const down = (over: Partial<NonNullable<ExtHealthInput["poller"]>> = {}) => ({ ts: ago(20), state: "ok", chrome_running: false, console_user: "console-a", ...over });

  it("Chrome down with the extension heartbeating 20 s ago is no_chrome — ANY extension age", () => {
    expect(one({ poller: down() })).toMatchObject({ status: "no_chrome", ext_age_s: 20, poller: { ok: true, chrome_running: false } });
  });

  it("Chrome down with a stale extension (3 h, or the Cardiology 25 h) is no_chrome, NOT missing: `missing` is red only when chrome_running=true", () => {
    expect(one({ poller: down(), last_ext: { ts: ago(3 * 3600), event: "heartbeat", reason: null } }).status).toBe("no_chrome");
    expect(one({ poller: down(), last_ext: { ts: ago(25 * 3600), event: "active", reason: null } }).status).toBe("no_chrome");
    expect(one({ poller: down(), last_ext: null }).status).toBe("no_chrome");
  });

  it("a tab_closed logout or an old version does not change it", () => {
    expect(one({ poller: down(), last_ext: { ts: ago(30 * MIN), event: "logout", reason: "tab_closed" } }).status).toBe("no_chrome");
    expect(one({ poller: down(), ext_version: "0.1.0.36" }).status).toBe("no_chrome");
  });

  it("offline outranks it (the poller is not ok / not fresh, so chrome_running says nothing)", () => {
    expect(one({ poller: down({ state: "unreachable" }) }).status).toBe("offline");
    expect(one({ poller: down({ ts: ago(5 * MIN + 1) }) }).status).toBe("offline");
  });

  it("chrome_running unknown (null) is not no_chrome", () => {
    expect(one({ poller: down({ chrome_running: null }), last_ext: null }).status).toBe("ok");
  });

  it("missing needs chrome_running=true: the same silent extension flips between the two on that flag alone", () => {
    const silent = { last_ext: { ts: ago(3 * 3600), event: "heartbeat", reason: null } };
    expect(one({ ...silent, poller: down({ chrome_running: true }) }).status).toBe("missing");
    expect(one({ ...silent, poller: down({ chrome_running: false }) }).status).toBe("no_chrome");
  });

  it("chrome_down_since is carried for no_chrome only", () => {
    expect(one({ poller: down(), chrome_down_since: ago(40 * MIN) })).toMatchObject({ status: "no_chrome", chrome_down_since: ago(40 * MIN) });
    expect(one({ chrome_down_since: ago(40 * MIN) }).chrome_down_since).toBeNull();
    expect(one({ poller: down() }).chrome_down_since).toBeNull();
  });
});

describe("rebooted_recently — the poller's unreachable -> ok flip with idle_s ~0 in the last 15 minutes", () => {
  const poll = (secAgo: number, state: string, idle_s: number | null) => ({ ts: ago(secAgo), state, idle_s });
  /** unreachable 8 and 6 min ago, back at 5 min ago with a fresh console session. */
  const flip = (idle = 3) => [poll(20 * MIN, "ok", 5000), poll(8 * MIN, "unreachable", null), poll(6 * MIN, "unreachable", null), poll(5 * MIN, "ok", idle), poll(4 * MIN, "ok", idle + 60)];
  const rb = (poller_recent: ExtHealthInput["poller_recent"], now = NOW) => computeExtHealth([mk({ poller_recent })], now)[0]!;

  it("flags the machine and says when it came back", () => {
    expect(rb(flip())).toMatchObject({ rebooted_recently: true, rebooted_at: ago(5 * MIN) });
  });

  it("is a flag on the row, not a status: a missing extension on a rebooted Mac is `missing` with the flag set", () => {
    const r = computeExtHealth([mk({ poller_recent: flip(), last_ext: { ts: ago(2 * 3600), event: "active", reason: null } })], NOW)[0]!;
    expect(r).toMatchObject({ status: "missing", rebooted_recently: true });
  });

  it("no flip, no flag: a steady ok history, an empty or absent history", () => {
    expect(rb([poll(900, "ok", 4000), poll(600, "ok", 4000), poll(30, "ok", 4000)])).toMatchObject({ rebooted_recently: false, rebooted_at: null });
    expect(rb([])).toMatchObject({ rebooted_recently: false, rebooted_at: null });
    expect(computeExtHealth([mk()], NOW)[0]).toMatchObject({ rebooted_recently: false, rebooted_at: null });
  });

  it("idle_s must have reset: 120 s counts as ~0, 121 s and 'no idle_s' do not (a network blip is not a restart)", () => {
    expect(rb(flip(120)).rebooted_recently).toBe(true);
    expect(rb(flip(121)).rebooted_recently).toBe(false);
    expect(rb([poll(8 * MIN, "unreachable", null), poll(5 * MIN, "ok", null)]).rebooted_recently).toBe(false);
  });

  it("the flip must be inside the last 15 minutes: 14 min 59 s is recent, 15 min 01 s is not", () => {
    expect(rb([poll(16 * MIN, "unreachable", null), poll(15 * MIN - 1, "ok", 2)]).rebooted_recently).toBe(true);
    expect(rb([poll(16 * MIN, "unreachable", null), poll(15 * MIN + 1, "ok", 2)]).rebooted_recently).toBe(false);
  });

  it("only an unreachable row immediately before the ok counts (ok, ok with a low idle is a user returning to the desk)", () => {
    expect(rb([poll(10 * MIN, "ok", 3000), poll(5 * MIN, "ok", 2)]).rebooted_recently).toBe(false);
  });

  it("order-independent, and the newest qualifying flip wins", () => {
    const rows = [poll(2 * MIN, "ok", 1), poll(5 * MIN, "unreachable", null), poll(3 * MIN, "ok", 4), poll(13 * MIN, "unreachable", null), poll(12 * MIN, "ok", 2)];
    expect(rb(rows)).toMatchObject({ rebooted_recently: true, rebooted_at: ago(3 * MIN) });
  });

  it("OPD 4, 5 Oct: unreachable 15:22-15:30 IST and again 15:42 IST — the 15:31 flip is flagged until 15:46, the 15:50 flip until 16:05", () => {
    const at = (hhmm: string) => `2026-10-05T${hhmm}:00.000Z`; // UTC = IST - 5:30
    const hist = [
      { ts: at("09:51"), state: "ok", idle_s: 900 }, { ts: at("09:52"), state: "unreachable", idle_s: null }, { ts: at("10:00"), state: "unreachable", idle_s: null },
      { ts: at("10:01"), state: "ok", idle_s: 4 }, { ts: at("10:05"), state: "ok", idle_s: 300 },
      { ts: at("10:12"), state: "unreachable", idle_s: null }, { ts: at("10:13"), state: "unreachable", idle_s: null },
      { ts: at("10:20"), state: "ok", idle_s: 2 }, { ts: at("10:24"), state: "ok", idle_s: 240 },
    ];
    const when = (hhmm: string) => computeExtHealth([mk({ poller_recent: hist, poller: { ts: at(hhmm), state: "ok", chrome_running: true, console_user: "console-a" } })], Date.parse(at(hhmm)))[0]!;
    expect(when("10:10")).toMatchObject({ rebooted_recently: true, rebooted_at: at("10:01") }); // 15:40 IST
    expect(when("10:25")).toMatchObject({ rebooted_recently: true, rebooted_at: at("10:20") }); // 15:55 IST: the 15:50 flip; the 15:31 one is 24 min old
    expect(when("10:36")).toMatchObject({ rebooted_recently: false, rebooted_at: null }); // 16:06 IST
  });
});

describe("rebooted_recently — pattern (b): the poller stayed ok but the console idle counter dropped while the extension went quiet (the Cardiology 14:09 pattern)", () => {
  // 4 Oct 2026, IST -> UTC (-5:30). Measured: poller 14:08 idle 1028, 14:09 idle 0 (lock=true), 14:10 idle 30; last extension row 14:09:27; the poller never saw
  // `unreachable` because the reboot fell between two polls.
  const T = (hhmmss: string) => `2026-10-04T${hhmmss}.000Z`;
  const polls = [
    { ts: T("08:37:50"), state: "ok", idle_s: 1028 }, // 14:07:50 IST
    { ts: T("08:38:50"), state: "ok", idle_s: 1088 },
    { ts: T("08:39:50"), state: "ok", idle_s: 0 }, // 14:09:50 IST: the reboot is behind us
    { ts: T("08:40:50"), state: "ok", idle_s: 30 },
  ];
  const LAST_EXT = "2026-10-04T08:39:27.360Z"; // 14:09:27 IST
  const at = (hhmmss: string, over: Partial<ExtHealthInput> = {}) => {
    const t = Date.parse(T(hhmmss));
    const newest = polls.filter((p) => Date.parse(p.ts) <= t).pop()!;
    return computeExtHealth(
      [
        mk({
          last_ext: { ts: LAST_EXT, event: "active", reason: null },
          ext_version: "0.1.0.36",
          poller_recent: polls,
          poller: { ts: newest.ts, state: "ok", chrome_running: true, console_user: "console-a", idle_s: newest.idle_s },
          ...over,
        }),
      ],
      t,
    )[0]!;
  };

  it("flags the Cardiology reboot from the idle drop alone, and says when the Mac came back", () => {
    expect(at("08:45:00")).toMatchObject({ rebooted_recently: true, rebooted_at: T("08:39:50") }); // 14:15 IST
  });

  it("not before the extension has been silent for 2 minutes (a user logging out and back in is not a reboot until the extension stays quiet)", () => {
    expect(at("08:41:10").rebooted_recently).toBe(false); // 103 s after the last extension row
    expect(at("08:41:30").rebooted_recently).toBe(true); // 123 s
  });

  it("an extension that kept talking after the idle drop is not rebooted (someone logged out / locked, the extension never died)", () => {
    expect(at("08:45:00", { last_ext: { ts: T("08:42:00"), event: "heartbeat", reason: null } }).rebooted_recently).toBe(false);
  });

  it("no extension rows at all: nothing to say the extension went quiet at that moment", () => {
    expect(at("08:45:00", { last_ext: null }).rebooted_recently).toBe(false);
  });

  it("the idle drop must be from >= 600 s to <= 120 s: 599 -> 0 and 1088 -> 121 are not reboots, 600 -> 120 is", () => {
    const run = (before: number, after: number) =>
      computeExtHealth(
        [
          mk({
            last_ext: { ts: LAST_EXT, event: "active", reason: null },
            poller_recent: [
              { ts: T("08:38:50"), state: "ok", idle_s: before },
              { ts: T("08:39:50"), state: "ok", idle_s: after },
            ],
            poller: { ts: T("08:39:50"), state: "ok", chrome_running: true, console_user: "console-a", idle_s: after },
          }),
        ],
        Date.parse(T("08:45:00")),
      )[0]!.rebooted_recently;
    expect(run(599, 0)).toBe(false);
    expect(run(1088, 121)).toBe(false);
    expect(run(600, 120)).toBe(true);
  });

  it("window: 15 min after the idle-drop poll it is not recent any more", () => {
    expect(at("08:54:40").rebooted_recently).toBe(true); // 14:54:40 IST: 14 min 50 s after the 14:09:50 poll
    expect(at("08:55:00").rebooted_recently).toBe(false);
  });

  it("the Cardiology 4-5 Oct sequence: the idle drop at 14:09:58 IST is the ONLY reboot; the eight other drops (a console touched after 10+ min away, the extension long silent) are not", () => {
    const ist = (t: string) => new Date(Date.parse(`2026-10-${t}+05:30`)).toISOString(); // "04T14:09:58"
    const BEFORE_INSTALL = ist("03T18:07:00"); // 4 Oct, before the 13:50 re-install: the extension last spoke the evening before
    const AFTER_REBOOT = ist("04T14:09:27"); // 5 Oct: the extension never came back after the reboot
    const drops: Array<[string, string, boolean]> = [
      ["04T09:06:00", BEFORE_INSTALL, false],
      ["04T11:58:00", BEFORE_INSTALL, false],
      ["04T12:39:00", BEFORE_INSTALL, false],
      ["04T13:23:00", BEFORE_INSTALL, false],
      ["04T14:09:58", ist("04T14:09:27"), true], // 31 s before the drop: the extension died with the reboot
      ["05T08:03:00", AFTER_REBOOT, false],
      ["05T10:00:00", AFTER_REBOOT, false],
      ["05T13:13:00", AFTER_REBOOT, false],
      ["05T14:24:00", AFTER_REBOOT, false],
    ];
    for (const [dropAt, lastExt, expected] of drops) {
      const t = Date.parse(ist(dropAt));
      const r = computeExtHealth(
        [
          mk({
            last_ext: { ts: lastExt, event: "active", reason: null },
            poller_recent: [
              { ts: new Date(t - 60_000).toISOString(), state: "ok", idle_s: 900 },
              { ts: new Date(t).toISOString(), state: "ok", idle_s: 4 },
            ],
            poller: { ts: new Date(t).toISOString(), state: "ok", chrome_running: true, console_user: "console-a", idle_s: 4 },
          }),
        ],
        t + 3 * 60_000,
      )[0]!;
      expect(r.rebooted_recently, dropAt).toBe(expected);
      expect(r.rebooted_at, dropAt).toBe(expected ? new Date(t).toISOString() : null);
    }
  });

  it("the last extension event must lie within 2 minutes EITHER side of the drop: 120 s before counts, 121 s before does not", () => {
    const t = Date.parse(T("08:39:50"));
    const run = (extSecBefore: number) =>
      computeExtHealth(
        [
          mk({
            last_ext: { ts: new Date(t - extSecBefore * 1000).toISOString(), event: "active", reason: null },
            poller_recent: [
              { ts: T("08:38:50"), state: "ok", idle_s: 900 },
              { ts: T("08:39:50"), state: "ok", idle_s: 0 },
            ],
            poller: { ts: T("08:39:50"), state: "ok", chrome_running: true, console_user: "console-a", idle_s: 0 },
          }),
        ],
        t + 5 * 60_000,
      )[0]!.rebooted_recently;
    expect(run(120)).toBe(true);
    expect(run(121)).toBe(false);
    expect(run(-120)).toBe(true); // 120 s AFTER the drop
  });

  it("it is a flag, not a status: the Cardiology row is `missing` at 14:25 IST, idle_s 657 s, with the flag set", () => {
    // 14:20 IST: age 633 s, idle 357 s (somebody used the Mac at ~14:14, after the extension died) -> missing, not quiet.
    const r = computeExtHealth(
      [
        mk({
          last_ext: { ts: LAST_EXT, event: "active", reason: null },
          ext_version: "0.1.0.36",
          poller_recent: polls,
          poller: { ts: T("08:49:50"), state: "ok", chrome_running: true, console_user: "console-a", idle_s: 357 },
        }),
      ],
      Date.parse(T("08:50:00")),
    )[0]!;
    expect(r).toMatchObject({ status: "missing", rebooted_recently: true, ext_age_s: 633 });
  });
});

describe("status — quiet (nobody touched the Mac since the extension went quiet)", () => {
  /** Extension silent for extAge s on a reachable Mac with Chrome up; the poll is pollAge s old and says the console has been idle idle_s. */
  const silent = (extAge: number, idle: number | null, pollAge = 0, over: Partial<ExtHealthInput> = {}) =>
    computeExtHealth(
      [
        mk({
          last_ext: { ts: ago(extAge), event: "heartbeat", reason: null },
          poller: { ts: ago(pollAge), state: "ok", chrome_running: true, console_user: "console-a", idle_s: idle },
          ...over,
        }),
      ],
      NOW,
    )[0]!;

  it("OPD 7, 5 Oct 06:50 IST: extension silent 780 s, console idle 726 s = quiet, not missing", () => {
    expect(silent(780, 726)).toMatchObject({ status: "quiet", ext_age_s: 780, poller: { idle_s: 726 }, behind_since: null, chrome_down_since: null });
  });

  it("the margin: idle_s == ext_age_s - 60 is quiet, one second less is missing", () => {
    expect(silent(1000, 940).status).toBe("quiet");
    expect(silent(1000, 939).status).toBe("missing");
  });

  it("the poll is not fresh: its idle_s is topped up by the poll's age (idle 900 s on a 40 s old poll = 940 s)", () => {
    expect(silent(1000, 900, 40).status).toBe("quiet");
    expect(silent(1000, 900, 39).status).toBe("missing");
  });

  it("a console idle for a day beside a silent extension is quiet", () => {
    expect(silent(112_853, 112_853).status).toBe("quiet");
  });

  it("the Cardiology case stays `missing`: somebody used the Mac after the extension died (age 93 033 s, idle 492 s; 5 Oct 06:00 IST: age 57 033, idle 56 715)", () => {
    expect(silent(93_033, 492).status).toBe("missing");
    expect(silent(57_033, 56_715).status).toBe("missing"); // idle trails the age by 318 s: the 14:14 login after the reboot
  });

  it("no idle_s on the poll proves nothing: missing", () => {
    expect(silent(1000, null).status).toBe("missing");
    expect(silent(1000, undefined as unknown as null).status).toBe("missing");
  });

  it("only a SILENT extension is quiet: an alive extension is ok / behind whatever the idle time", () => {
    expect(silent(20, 5000).status).toBe("ok");
    expect(silent(20, 5000, 0, { ext_version: "0.1.0.35" }).status).toBe("behind");
  });

  it("no_tab outranks quiet; no_chrome and offline outrank both; chrome_running unknown stays ok", () => {
    expect(silent(1800, 1800, 0, { last_ext: { ts: ago(1800), event: "logout", reason: "tab_closed" } }).status).toBe("no_tab");
    expect(silent(1800, 1800, 0, { poller: { ts: ago(0), state: "ok", chrome_running: false, console_user: null, idle_s: 1800 } }).status).toBe("no_chrome");
    expect(silent(1800, 1800, 0, { poller: { ts: ago(0), state: "unreachable", chrome_running: true, console_user: null, idle_s: 1800 } }).status).toBe("offline");
    expect(silent(1800, 1800, 0, { poller: { ts: ago(0), state: "ok", chrome_running: null, console_user: null, idle_s: 1800 } }).status).toBe("ok");
  });

  it("the 10-minute edge still decides silent vs alive: 599 s is alive, 600 s with an idle console is quiet", () => {
    expect(silent(599, 599).status).toBe("ok");
    expect(silent(600, 600).status).toBe("quiet");
  });
});

describe("replay of 4 Oct 08:30 IST -> 5 Oct 16:00 IST: the measured false episodes drop, the real ones stay", () => {
  // [ext age s, console idle s] taken from the loader's output at 5-minute steps on 5 Oct 2026 (poller one minute old at most).
  const status = (ver: string, extAge: number, idle: number) =>
    computeExtHealth(
      [mk({ ext_version: ver, last_ext: { ts: ago(extAge), event: "heartbeat", reason: null }, poller: { ts: ago(10), state: "ok", chrome_running: true, console_user: "console-a", idle_s: idle } })],
      NOW,
    )[0]!.status;

  it("OPD 7 (0.1.0.35), 06:37-09:25 IST: the extension went quiet while the console sat idle; no episode of `missing` anywhere in the run", () => {
    const run: Array<[number, number]> = [
      [20, 112_853], [20, 113_154], // 06:25, 06:30: alive
      [180, 125], [480, 425], // 06:40, 06:45: alive (< 10 min)
      [780, 726], [1080, 1026], [1380, 1327], [1680, 1628], [1980, 1928], [2280, 2229], // 06:50 .. 07:15
      [9180, 9144], [9480, 9445], [9780, 9746], [10_080, 10_046], // 09:10 .. 09:25
      [8, 63], // 09:30: the extension is back
    ];
    const got = run.map(([a, i]) => status("0.1.0.35", a, i));
    expect(got).toEqual(["behind", "behind", "behind", "behind", "quiet", "quiet", "quiet", "quiet", "quiet", "quiet", "quiet", "quiet", "quiet", "quiet", "behind"]);
    expect(got).not.toContain("missing");
  });

  it("OPD 6 (0.1.0.34), 13:18-14:34 IST: same shape, no `missing`", () => {
    const run: Array<[number, number]> = [
      [86, 73], [386, 374], // 13:20, 13:25
      [686, 675], [986, 975], [1286, 1276], [1586, 1577], [1886, 1877], [2186, 2178], [2486, 2479], [2786, 2779], [3086, 3080], [3386, 3381], [3686, 3681], [3986, 3982], [4286, 4284], // 13:30 .. 14:30
      [2, 0], // 14:35: back
    ];
    const got = run.map(([a, i]) => status("0.1.0.34", a, i));
    expect(got.slice(0, 2)).toEqual(["behind", "behind"]);
    expect(got.slice(2, 15).every((s) => s === "quiet")).toBe(true);
    expect(got[15]).toBe("behind");
    expect(got).not.toContain("missing");
  });

  it("Cardiology (0.1.0.36), OPD 4 (0.1.0.32) and Dietary (0.1.0.21) stay `missing`", () => {
    expect(status("0.1.0.36", 633, 357)).toBe("missing"); // 4 Oct 14:20 IST, ten minutes after the reboot
    expect(status("0.1.0.36", 1833, 1500)).toBe("missing"); // 14:40
    expect(status("0.1.0.36", 78_633, 235)).toBe("missing"); // 5 Oct 12:00
    expect(status("0.1.0.36", 93_033, 492)).toBe("missing"); // 5 Oct 16:00
    expect(status("0.1.0.32", 860, 1)).toBe("missing"); // OPD 4, 5 Oct 15:35: back from the 15:22 outage, extension never returned
    expect(status("0.1.0.32", 2360, 829)).toBe("missing"); // 16:00
    expect(status("0.1.0.21", 146_317, 0)).toBe("missing"); // Dietary 5 Oct 10:05, just back up
    expect(status("0.1.0.21", 167_617, 2838)).toBe("missing"); // 16:00
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
    expect(summarizeExtHealth([])).toEqual({ ok: 0, no_tab: 0, missing: 0, quiet: 0, behind: 0, offline: 0, no_chrome: 0, total: 0 });
    const rows = computeExtHealth(
      [
        mk({ machine: "m1" }),
        mk({ machine: "m2", ext_version: "0.1.0.36" }),
        mk({ machine: "m3", ext_version: "0.1.0.36" }),
        mk({ machine: "m4", last_ext: null }),
        mk({ machine: "m5", last_ext: { ts: ago(30 * MIN), event: "logout", reason: "tab_closed" } }),
        mk({ machine: "m6", poller: null }),
        mk({ machine: "m7", poller: { ts: ago(30), state: "ok", chrome_running: false, console_user: null } }),
        mk({ machine: "m8", last_ext: { ts: ago(30 * MIN), event: "heartbeat", reason: null }, poller: { ts: ago(0), state: "ok", chrome_running: true, console_user: null, idle_s: 30 * MIN } }),
      ],
      NOW,
    );
    expect(summarizeExtHealth(rows)).toEqual({ ok: 1, no_tab: 1, missing: 1, quiet: 1, behind: 2, offline: 1, no_chrome: 1, total: 8 });
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
    { machine: "EHRC-ECHOs-Mac-mini", ext_event: "active", ext_ts: "2026-10-04T08:39:27.360Z", ext_reason: null, ver: "0.1.0.36", poller_ts: ago(30), poller_state: "ok", chrome: "true", console_user: "console-a", poller_idle: "1200.5" },
    // OPD 5: alive, on 0.1.0.33 — BEHIND.
    { machine: "EHRC-CONSUL5s-Mac-mini", ext_event: "heartbeat", ext_ts: ago(10), ext_reason: null, ver: "0.1.0.33", poller_ts: ago(30), poller_state: "ok", chrome: "true", console_user: "console-b" },
  ];
  const responder = (q: Q): unknown => {
    if (/FROM room_install/.test(q.text)) return ROOMS;
    if (/LEFT JOIN LATERAL/.test(q.text)) return eventRows;
    if (/AS since/.test(q.text)) return [{ machine: "EHRC-CONSUL5s-Mac-mini", since: ago(4 * 3600) }];
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
    expect(rows[0]!.poller.idle_s).toBe(1200.5); // numeric text from the driver, coerced
    expect(rows[1]!.poller.idle_s).toBeNull();
  });

  it("every machine is matched under all its spellings: canonical, raw hostname, and the pre-5-Oct poller short key (so an as_of replay finds old rows)", async () => {
    const { db, issued } = fakeDb(responder);
    await extHealth(db, { asOf: NOW });
    const presence = issued.find((q) => /LEFT JOIN LATERAL/.test(q.text))!;
    const parsed = JSON.parse(String(presence.vals[0])) as Array<{ n: string; keys: string[] }>;
    expect(parsed).toContainEqual({ n: "EHRC-ECHOs-Mac-mini", keys: ["EHRC-ECHOs-Mac-mini", "EHRC-ECHO\u2019s Mac mini", "echo"] });
    expect(parsed).toContainEqual({ n: "EHRC-CONSUL5s-Mac-mini", keys: ["EHRC-CONSUL5s-Mac-mini", "EHRC-CONSUL5\u2019s Mac mini", "consul5"] });
    // the old short key is for POLLER lookups only: no extension lookup uses the alias set
    expect(presence.text).not.toContain("'ext' AND p.machine = k.key");
    expect(presence.text.match(/'ext' AND p\.machine = m\.n/g)).toHaveLength(2); // newest event, newest version
    for (const q of issued.filter((x) => /AS since/.test(x.text))) expect(q.text).not.toContain("m.keys");
    for (const q of issued.filter((x) => /AS idle_s|AS chrome_down_since/.test(x.text))) expect(q.text).toContain("m.keys");
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
    const since = a.issued.filter((q) => /AS since/.test(q.text));
    expect(since).toHaveLength(1);
    expect(String(since[0]!.vals[0])).toContain("EHRC-CONSUL5s-Mac-mini");
    expect(String(since[0]!.vals[0])).not.toContain("EHRC-ECHOs-Mac-mini");
    expect(since[0]!.vals.find((v) => Array.isArray(v))).toEqual([0, 1, 1, 39]);
    expect(since[0]!.vals).toContain(new Date(NOW - 2 * 3_600_000).toISOString()); // the 2-hour look-back, not 24 h

    const b = fakeDb((q) => (/LEFT JOIN LATERAL/.test(q.text) ? [{ ...eventRows[1]!, ver: "0.1.1.39" }] : /FROM room_install/.test(q.text) ? ROOMS : []));
    await extHealth(b.db, { asOf: NOW });
    expect(b.issued.filter((q) => /AS since/.test(q.text))).toHaveLength(0);
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
    expect(rows.map((r) => r.status)).toEqual(["no_chrome", "offline"]); // chrome_running=false on an ok poll
  });

  it("a bad asOf is refused", async () => {
    const { db } = fakeDb(responder);
    await expect(extHealth(db, { asOf: "nope" })).rejects.toThrow(/bad asOf/);
  });
});

describe("loadExtHealthInputs — Chrome-down start and the reboot history", () => {
  const base = { ext_event: "heartbeat", ext_ts: ago(10), ext_reason: null, ver: "0.1.1.39", poller_ts: ago(10), poller_state: "ok", console_user: "console-a" };

  it("the Chrome-down read runs ONLY for machines whose newest poll is ok with chrome_running=false, and its answer lands on the row", async () => {
    const rowsFor = (chrome5: string) => [
      { machine: "EHRC-ECHOs-Mac-mini", ...base, chrome: "false" },
      { machine: "EHRC-CONSUL5s-Mac-mini", ...base, chrome: chrome5 },
    ];
    const run = (chrome5: string) =>
      fakeDb((q) => {
        if (/FROM room_install/.test(q.text)) return ROOMS;
        if (/LEFT JOIN LATERAL/.test(q.text)) return rowsFor(chrome5);
        if (/AS chrome_down_since/.test(q.text)) return [{ machine: "EHRC-ECHOs-Mac-mini", chrome_down_since: ago(50 * 60) }];
        return [];
      });
    const a = run("true");
    const rows = await extHealth(a.db, { asOf: NOW });
    const down = a.issued.filter((q) => /AS chrome_down_since/.test(q.text));
    expect(down).toHaveLength(1);
    expect(String(down[0]!.vals[0])).toContain("EHRC-ECHOs-Mac-mini");
    expect(String(down[0]!.vals[0])).not.toContain("EHRC-CONSUL5s-Mac-mini");
    expect(rows[0]).toMatchObject({ status: "no_chrome", chrome_down_since: ago(50 * 60) });
    expect(rows[1]!.status).toBe("ok");

    const b = run("false");
    await extHealth(b.db, { asOf: NOW });
    expect(String(b.issued.find((q) => /AS chrome_down_since/.test(q.text))!.vals[0])).toContain("EHRC-CONSUL5s-Mac-mini");
  });

  it("no machine is Chrome-down: that read is never issued", async () => {
    const { db, issued } = fakeDb((q) => (/FROM room_install/.test(q.text) ? ROOMS : /LEFT JOIN LATERAL/.test(q.text) ? [{ machine: "EHRC-ECHOs-Mac-mini", ...base, chrome: "true" }] : []));
    await extHealth(db, { asOf: NOW });
    expect(issued.some((q) => /AS chrome_down_since/.test(q.text))).toBe(false);
  });

  it("one bound poller-history read for the whole fleet (excluded machines absent), idle_s coerced to a number, and the flip becomes rebooted_recently", async () => {
    const hist = [
      { machine: "EHRC-ECHOs-Mac-mini", ts: ago(8 * 60), state: "unreachable", idle_s: null },
      { machine: "EHRC-ECHOs-Mac-mini", ts: ago(5 * 60), state: "ok", idle_s: "3" },
      { machine: "EHRC-CONSUL5s-Mac-mini", ts: ago(5 * 60), state: "ok", idle_s: "3000.5" },
    ];
    const { db, issued } = fakeDb((q) => (/FROM room_install/.test(q.text) ? ROOMS : /LEFT JOIN LATERAL/.test(q.text) ? [{ machine: "EHRC-ECHOs-Mac-mini", ...base, chrome: "true" }] : /AS idle_s/.test(q.text) ? hist : []));
    const rows = await extHealth(db, { asOf: NOW });
    const reads = issued.filter((q) => /AS idle_s/.test(q.text));
    expect(reads).toHaveLength(1);
    expect(String(reads[0]!.vals[0])).toContain("EHRC-ECHOs-Mac-mini");
    for (const banned of ["Vinay", "ORBOX3", "orb2"]) expect(String(reads[0]!.vals[0])).not.toContain(banned);
    expect(reads[0]!.vals).toContain(new Date(NOW).toISOString());
    expect(reads[0]!.vals).toContain(new Date(NOW - 30 * 60_000).toISOString());
    expect(reads[0]!.text).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    expect(rows[0]).toMatchObject({ rebooted_recently: true, rebooted_at: ago(5 * 60) });
    expect(rows[1]).toMatchObject({ rebooted_recently: false, rebooted_at: null });
    const inputs = await loadExtHealthInputs(db, new Date(NOW), [ROOMS[0]!, ROOMS[1]!]);
    expect(inputs[1]!.poller_recent).toEqual([{ ts: ago(5 * 60), state: "ok", idle_s: 3000.5 }]);
  });
});

// ---------------------------------------------------------------------------
// The presence guard fields (source 'guard' rows, 24 h)
// ---------------------------------------------------------------------------

describe("guard_* fields", () => {
  it("default to null / 0 / {} when the machine has no guard rows (absent, null, or an empty summary)", () => {
    const none = { guard_last_reason: null, guard_last_at: null, guard_first_at: null, guard_events_24h: 0, guard_relaunches_24h: 0, guard_reasons_24h: {} };
    expect(one()).toMatchObject(none);
    expect(one({ guard: null })).toMatchObject(none);
    expect(one({ guard: { last_reason: null, last_at: null, counts: {} } })).toMatchObject(none);
  });

  it("count every reason except boot as an event, relaunches separately; last_* is the newest row's reason and time", () => {
    const r = one({ guard: { last_reason: "boot", last_at: ago(60), first_at: ago(5000), counts: { boot: 2, stripped: 1, relaunch: 1, missing: 3 } } });
    expect(r.guard_first_at).toBe(ago(5000));
    expect(r.guard_last_reason).toBe("boot");
    expect(r.guard_last_at).toBe(ago(60));
    expect(r.guard_events_24h).toBe(5); // stripped 1 + relaunch 1 + missing 3; boot excluded
    expect(r.guard_relaunches_24h).toBe(1);
    expect(r.guard_reasons_24h).toEqual({ boot: 2, stripped: 1, relaunch: 1, missing: 3 });
  });

  it("boot alone is zero events and has no first non-boot time", () => {
    const r = one({ guard: { last_reason: "boot", last_at: ago(60), first_at: null, counts: { boot: 1 } } });
    expect(r.guard_first_at).toBeNull();
    expect(r.guard_events_24h).toBe(0);
    expect(r.guard_relaunches_24h).toBe(0);
  });
});

describe("loadExtHealthInputs — the guard read", () => {
  const isGuardQ = (q: Q) => /p\.source = 'guard'/.test(q.text);
  // What the GROUP BY machine, reason read returns: one row per group, count as the driver's bigint text.
  const guardRows = [
    { machine: "EHRC-ECHOs-Mac-mini", reason: "boot", n: "1", last_ts: ago(60), first_ts: ago(60) },
    { machine: "EHRC-ECHOs-Mac-mini", reason: "stripped", n: "1", last_ts: ago(3600), first_ts: ago(3600) },
    { machine: "EHRC-ECHOs-Mac-mini", reason: "relaunch", n: "1", last_ts: ago(3500), first_ts: ago(3500) },
    { machine: "EHRC-CONSUL5\u2019s Mac mini", reason: "missing", n: "2", last_ts: ago(7200), first_ts: ago(9000) }, // raw hostname spelling maps back to the canonical key
    { machine: "not-in-the-fleet", reason: "missing", n: "1", last_ts: ago(10), first_ts: ago(10) },
  ];
  const responder = (q: Q): unknown => (isGuardQ(q) ? guardRows : /FROM room_install/.test(q.text) ? ROOMS : []);

  it("is ONE machine-scoped, time-bounded, bound-parameter read, and maps rows to the canonical machine key (newest row first = last_*)", async () => {
    const { db, issued } = fakeDb(responder);
    const rows = await extHealth(db, { asOf: NOW });
    const gq = issued.filter(isGuardQ);
    expect(gq).toHaveLength(1);
    expect(gq[0]!.text).toMatch(/p\.machine = ANY\(/);
    expect(gq[0]!.text).toMatch(/p\.ts > .*AND p\.ts <= /s);
    expect(gq[0]!.text).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i);
    expect(gq[0]!.text).toMatch(/count\(\*\)/);
    expect(gq[0]!.text).toMatch(/GROUP BY 1, 2/); // aggregated in SQL: no per-row fetch, no LIMIT
    expect(gq[0]!.text).not.toMatch(/\bLIMIT\b/i);
    expect(gq[0]!.vals).toContain(new Date(NOW - 24 * 3_600_000).toISOString());
    expect(gq[0]!.vals).toContain(new Date(NOW).toISOString());
    const keys = gq[0]!.vals.find((v) => Array.isArray(v)) as string[];
    expect(keys).toEqual(expect.arrayContaining(["EHRC-ECHOs-Mac-mini", "EHRC-CONSUL5\u2019s Mac mini", "echo", "consul5"]));
    expect(keys.some((k) => /Vinay|ORBOX3|orb2/i.test(k))).toBe(false); // excluded machines are never asked about
    const cardio = rows.find((r) => r.room_name === "Cardiology OPD")!;
    expect(cardio).toMatchObject({ guard_last_reason: "boot", guard_last_at: ago(60), guard_first_at: ago(3600), guard_events_24h: 2, guard_relaunches_24h: 1, guard_reasons_24h: { boot: 1, stripped: 1, relaunch: 1 } });
    const opd5 = rows.find((r) => r.room_name === "OPD 5")!;
    expect(opd5).toMatchObject({ guard_last_reason: "missing", guard_last_at: ago(7200), guard_first_at: ago(9000), guard_events_24h: 2, guard_relaunches_24h: 0 });
  });

  it("no guard rows: every machine reads null/0; a failing guard read does not take the extension read down", async () => {
    const a = await extHealth(fakeDb((q) => (isGuardQ(q) ? [] : responder(q))).db, { asOf: NOW });
    expect(a.map((r) => [r.guard_last_reason, r.guard_events_24h, r.guard_relaunches_24h])).toEqual([[null, 0, 0], [null, 0, 0]]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = await extHealth(fakeDb((q) => { if (isGuardQ(q)) throw new Error("boom"); return responder(q); }).db, { asOf: NOW });
    warn.mockRestore();
    expect(b.map((r) => r.guard_events_24h)).toEqual([0, 0]);
  });
});
