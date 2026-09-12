/**
 * Tier 2 §2.1 / §2.2 — the assign-channel version floor and the two audit rows.
 *
 * WHY: on 12 Sep OPD 6 (0.1.21) was assigned `test`. The route took it, the row held it, and
 * nothing happened — a 0.1.20/0.1.21 app applies only `stable`, so the assignment was inert. The
 * only thing that would ever have named it was CHANNEL_DRIFT, thirty minutes later; it was cleared
 * by hand before that. A silent no-op is worse than a refusal, so `test` is now refused at assign
 * time, and every channel decision leaves an audit row so "when, by whom, from what" is answerable.
 *
 * No live database: `sql` is mocked and every statement is captured.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
type Call = { text: string; values: unknown[] };
const calls: Call[] = [];
const store: { install: Row | null } = { install: null };
/** What the poll UPDATE returns when this suite drives applyInstallPoll. */
let pollRow: Row | null = null;
/** Slice A fix-up — make the poll UPDATE throw, as a missing column would. */
let throwPoll = false;

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    if (/^SELECT install_id, room_id, app_version, assigned_channel FROM room_install/.test(text)) {
      return Promise.resolve(store.install ? [store.install] : []);
    }
    if (/^UPDATE room_install SET assigned_channel/.test(text)) {
      return Promise.resolve(store.install ? [{ install_id: values[1], assigned_channel: values[0] }] : []);
    }
    if (/^UPDATE room_install SET last_seen_at/.test(text)) {
      if (throwPoll) return Promise.reject(new Error('column poll_ring does not exist'));
      return Promise.resolve(pollRow ? [pollRow] : []);
    }
    return Promise.resolve([]);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});
vi.mock("@/lib/cookie", () => ({ readAdminCookie: async () => null }));

process.env.MIGRATION_SECRET = "test-secret";
const C = await import("@/lib/bench-bus-constants");
const RI = await import("@/lib/room-install");
const route = await import("@/app/api/admin/installs/[installId]/assign-channel/route");
const BC = await import("@/lib/bench-commands");

const ID = "install_opd6";
beforeEach(() => {
  calls.length = 0;
  pollRow = null;
  store.install = { install_id: ID, room_id: "room_opd6", app_version: "0.1.21", assigned_channel: null };
});

const post = async (channel: string) => {
  const req = new Request("https://www.evenscribe.app/api/admin/installs/x/assign-channel", {
    method: "POST",
    headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
    body: JSON.stringify({ channel }),
  });
  const res = await route.POST(req as never, { params: Promise.resolve({ installId: ID }) });
  return { status: res.status, json: (await res.json()) as Row };
};
const audits = () => calls.filter((c) => /^INSERT INTO audit_log/.test(c.text));

// ---------------------------------------------------------------------------
// §2.1 — the floor, at both sides of 0.1.22
// ---------------------------------------------------------------------------

describe("assignChannelRefusal — pure, and only `test` is gated", () => {
  it("refuses test below 0.1.22 and allows it at or above", () => {
    for (const v of ["0.1.21", "0.1.20", "0.1.8", "0.1.3", null, "", "v0.1.22", "0.1.22-rc1"]) {
      expect(C.assignChannelRefusal("test", v)?.code, String(v)).toBe("APP_TOO_OLD");
    }
    for (const v of ["0.1.22", "0.1.23", "0.1.100", "0.2.0", "1.0.0"]) {
      expect(C.assignChannelRefusal("test", v), String(v)).toBeNull();
    }
  });

  it("never gates `stable` — the rollback path must not depend on a version floor", () => {
    for (const v of ["0.1.8", "0.1.21", null, "", "0.1.22"]) {
      expect(C.assignChannelRefusal("stable", v), String(v)).toBeNull();
    }
  });

  it("the floor constant is the verbs' floor, stated once", () => {
    expect(C.TEST_CHANNEL_MIN_APP_VERSION).toBe("0.1.22");
  });

  it("the message names the reported version and why it would be inert", () => {
    const r = C.assignChannelRefusal("test", "0.1.21")!;
    expect(r.app_version).toBe("0.1.21");
    expect(r.message).toContain("0.1.21");
    expect(r.message).toContain("0.1.22");
    expect(r.message).toMatch(/inert|only stable/i);
  });
});

describe("the route refuses test on a 0.1.21 install with 409 APP_TOO_OLD", () => {
  it("409, and NOTHING is written — no UPDATE, no audit row", async () => {
    const { status, json } = await post("test");
    expect(status).toBe(409);
    expect((json.error as Row).code).toBe("APP_TOO_OLD");
    expect(calls.filter((c) => /^UPDATE room_install SET assigned_channel/.test(c.text))).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });

  it("the same install on 0.1.22 is accepted", async () => {
    store.install!.app_version = "0.1.22";
    const { status, json } = await post("test");
    expect(status).toBe(200);
    expect(json).toEqual({ install_id: ID, assigned_channel: "test" });
  });

  it("stable is accepted on the very same 0.1.21 install", async () => {
    const { status, json } = await post("stable");
    expect(status).toBe(200);
    expect(json).toEqual({ install_id: ID, assigned_channel: "stable" });
  });

  it("an unknown or retired install is still 404, and the floor never runs", async () => {
    store.install = null;
    expect((await post("test")).status).toBe(404);
    expect(audits()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §2.2 — the audit rows
// ---------------------------------------------------------------------------

describe("install.assign_channel audit row", () => {
  // The INSERT interpolates four values — actor, action, install_id, metadata. 'system' and
  // 'room_install' are literals in the statement, not parameters.
  const meta = (c: Call) => JSON.parse(String(c.values[3])) as Row;

  it("carries install_id, room_id, from, to and the actor", async () => {
    store.install!.assigned_channel = "stable";
    store.install!.app_version = "0.1.22";
    await post("test");
    const a = audits();
    expect(a).toHaveLength(1);
    expect(a[0]!.values[0]).toBe("migration_secret"); // actor_id, from installAdminGuard
    expect(a[0]!.values[1]).toBe("install.assign_channel");
    expect(a[0]!.values[2]).toBe(ID);
    expect(a[0]!.text).toMatch(/INSERT INTO audit_log .*VALUES \('system', \?, \?, 'room_install', \?/);
    expect(meta(a[0]!)).toMatchObject({
      install_id: ID, room_id: "room_opd6", from: "stable", to: "test", actor: "migration_secret",
    });
  });

  it("`from` is null on the first assignment of the day, and names the replaced value after that", async () => {
    store.install!.app_version = "0.1.22";
    await post("test");
    expect(meta(audits()[0]!).from).toBeNull();
    expect(meta(audits()[0]!).to).toBe("test");
  });

  it("carries nothing free-text — no hostname, no device name", async () => {
    store.install!.app_version = "0.1.22";
    store.install!.hostname = "EHRC-DISCUSSION\u2019s Mac mini";
    await post("stable");
    expect(Object.keys(meta(audits()[0]!)).sort()).toEqual(
      ["actor", "from", "install_id", "room_id", "to"].sort(),
    );
  });

  it("a refused assignment writes no audit row at all", async () => {
    await post("test"); // 0.1.21 -> 409
    expect(audits()).toHaveLength(0);
  });
});

describe("install.channel_reported — written once, on the poll where the assignment clears", () => {
  const run = async (prev: string | null, now: string | null, reported: string | null) => {
    calls.length = 0;
    store.install = null; // this suite drives applyInstallPoll, not the route
    pollRow = { install_id: ID, assigned_channel: now, prev_assigned_channel: prev, prev_room_id: "room_opd6", update_channel: reported };
    await RI.applyInstallPoll({ install_id: ID, ...(reported ? { update_channel: reported } : {}) });
    return audits();
  };

  it("writes exactly one row when a set assignment becomes null", async () => {
    const a = await run("test", null, "test");
    expect(a).toHaveLength(1);
    expect(a[0]!.values[0]).toBe("install");
    expect(a[0]!.values[1]).toBe("install.channel_reported");
    expect(JSON.parse(String(a[0]!.values[3]))).toMatchObject({
      install_id: ID, channel: "test", cleared: "test", room_id: "room_opd6",
    });
  });

  it("writes NOTHING on an ordinary poll — assignment unchanged, or never set", async () => {
    expect(await run(null, null, "stable")).toHaveLength(0);   // never assigned
    expect(await run("test", "test", "stable")).toHaveLength(0); // still pending
  });

  it("writes nothing on the polls AFTER the clear — once per transition, not once per poll", async () => {
    expect(await run("test", null, "test")).toHaveLength(1);
    expect(await run(null, null, "test")).toHaveLength(0);
    expect(await run(null, null, "test")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Slice A fix-up, ruling 3 — the fail-open poll write is loud, and bounded
// ---------------------------------------------------------------------------

describe("install.poll_write_failed — loud, and one row per install per five minutes", () => {
  /** Make the poll UPDATE throw, the way a column the database has not got would. */
  const withThrowingPoll = async (fn: () => Promise<void>) => {
    throwPoll = true;
    try {
      await fn();
    } finally {
      throwPoll = false;
    }
  };

  beforeEach(() => {
    RI.__resetRateLimits();
  });

  it("ten rapid polls on one install write exactly ONE audit row", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await withThrowingPoll(async () => {
      for (let k = 0; k < 10; k++) {
        await BC.pollCommands({
          roomId: "room_opd6", tabId: "app_install_opd6", prevPollAt: null,
          recordingSessionId: null, paused: false, install: { install_id: ID },
        } as never);
      }
    });
    const rows = calls.filter((c) => /^INSERT INTO audit_log/.test(c.text) && String(c.values[1]) === "install.poll_write_failed");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.values[0]).toBe("install");
    expect(rows[0]!.values[2]).toBe(ID);
    const meta = JSON.parse(String(rows[0]!.values[3])) as Row;
    expect(meta.install_id).toBe(ID);
    expect(String(meta.error)).toContain("column poll_ring does not exist");
    // The CONSOLE line is not rate-limited: a log that drops the repeats hides how long the
    // fault has been running. Ten failures, ten console.error calls.
    expect(err).toHaveBeenCalledTimes(10);
    err.mockRestore();
  });

  it("a second install in the same window gets its own row — the limit is per install", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await withThrowingPoll(async () => {
      for (const id of [ID, "install_other", ID, "install_other"]) {
        await BC.pollCommands({
          roomId: "room_opd6", tabId: `app_${id}`, prevPollAt: null,
          recordingSessionId: null, paused: false, install: { install_id: id },
        } as never);
      }
    });
    const rows = calls.filter((c) => /^INSERT INTO audit_log/.test(c.text) && String(c.values[1]) === "install.poll_write_failed");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.values[2]).sort()).toEqual([ID, "install_other"].sort());
    err.mockRestore();
  });

  it("the window is five minutes, and the next window writes again", () => {
    expect(RI.POLL_WRITE_FAIL_AUDIT).toEqual({ max: 1, windowMs: 300_000 });
    const t0 = 1_000_000;
    const key = "poll_write_fail:install_x";
    expect(RI.rateLimited(key, RI.POLL_WRITE_FAIL_AUDIT, t0)).toBe(false);      // first: writes
    expect(RI.rateLimited(key, RI.POLL_WRITE_FAIL_AUDIT, t0 + 1_000)).toBe(true);  // suppressed
    expect(RI.rateLimited(key, RI.POLL_WRITE_FAIL_AUDIT, t0 + 299_999)).toBe(true);
    expect(RI.rateLimited(key, RI.POLL_WRITE_FAIL_AUDIT, t0 + 300_001)).toBe(false); // writes again
  });

  it("the poll still fails OPEN — a recording room is never stopped by a bookkeeping fault", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let out: unknown;
    await withThrowingPoll(async () => {
      out = await BC.pollCommands({
        roomId: "room_opd6", tabId: "app_install_opd6", prevPollAt: null,
        recordingSessionId: "bs_1", paused: false, install: { install_id: ID },
      } as never);
    });
    expect(out).toBeTruthy();
    expect((out as Row).retired).toBeUndefined();
    err.mockRestore();
  });
});
