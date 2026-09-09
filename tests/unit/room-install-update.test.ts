/**
 * Build R3 §13.4 — the poll's new columns, and the three row changes they pay for.
 *
 * ─── THE TWO COALESCE RULES ARE OPPOSITE, AND BOTH ARE LOAD-BEARING ──────────────────────────
 * The five update columns COALESCE so a failure STICKS: the app that attempted the update is gone,
 * its successor reports the receipt on exactly one poll and deletes the file, and every poll after
 * that omits the fields. Without the COALESCE the card would forget why a room is on the old
 * version one and a half seconds after being told.
 *
 * `session_open` does the reverse and MUST. It is a live reading of whether a patient is in the
 * room, the whole of R3-3 rests on it being able to go false, and a COALESCE would freeze a room at
 * "recording" the moment its last session ended — bringing the false tape warning straight back.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const calls: Array<{ text: string; values: unknown[] }> = [];
let responses: unknown[] = [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
    const next = responses.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? []);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});

const M = await import("@/lib/room-install");
const V = await import("@/lib/room-install-view");

beforeEach(() => {
  calls.length = 0;
  responses = [];
});

// ---------------------------------------------------------------------------
// cleanPollFields — what a Mac is allowed to claim
// ---------------------------------------------------------------------------

describe("the R3 poll fields, sanitised (§5.5)", () => {
  it("keeps only the named outcomes", () => {
    for (const ok of [
      "ok",
      "checksum_mismatch",
      "signature_mismatch",
      "download_failed",
      "expand_failed",
      "swap_failed",
      // Fix 2, G1 — a correctly signed bundle that is labelled wrong.
      "version_mismatch",
    ]) {
      expect(M.cleanPollFields({ install_id: "i", last_update_result: ok }).last_update_result).toBe(ok);
    }
    for (const bad of ["OK", "exploded", "", "swap-failed", "ok!"]) {
      expect(
        M.cleanPollFields({ install_id: "i", last_update_result: bad }).last_update_result,
      ).toBeNull();
    }
  });

  it("keeps only the two channels, and never coerces an unknown one to stable", () => {
    expect(M.cleanPollFields({ install_id: "i", update_channel: "test" }).update_channel).toBe("test");
    expect(M.cleanPollFields({ install_id: "i", update_channel: "stable" }).update_channel).toBe("stable");
    // Null, not "stable". An unknown channel is "not reported", and the COALESCE keeps whatever the
    // row held — which is not the same as asserting this Mac is on stable.
    expect(M.cleanPollFields({ install_id: "i", update_channel: "beta" }).update_channel).toBeNull();
  });

  it("NEVER accepts 0 or a negative disk reading (§5.5, V's 9 Sep addition)", () => {
    // "0 bytes free" is a clinical emergency. It must be impossible for a failed read to produce
    // it, so the value is dropped rather than stored.
    for (const bad of ["0", "-1", "", "  ", "1.5", "9e9", "abc", null, undefined, -1, 0]) {
      expect(
        M.cleanPollFields({ install_id: "i", disk_free_bytes: bad as never }).disk_free_bytes,
      ).toBeNull();
    }
    expect(M.cleanPollFields({ install_id: "i", disk_free_bytes: "412000000000" }).disk_free_bytes)
      .toBe("412000000000");
    expect(M.cleanPollFields({ install_id: "i", disk_free_bytes: 412_000_000_000 }).disk_free_bytes)
      .toBe("412000000000");
  });

  it("takes session_open as a real tri-state", () => {
    expect(M.cleanPollFields({ install_id: "i", session_open: true }).session_open).toBe(true);
    expect(M.cleanPollFields({ install_id: "i", session_open: false }).session_open).toBe(false);
    // Absent stays absent. Every install below 0.1.8 reports nothing here, for ever.
    expect(M.cleanPollFields({ install_id: "i" }).session_open).toBeNull();
  });

  it("drops an unparseable update time rather than failing the whole poll", () => {
    expect(M.cleanPollFields({ install_id: "i", last_update_at: "not a date" }).last_update_at).toBeNull();
    expect(M.cleanPollFields({ install_id: "i", last_update_at: "2026-09-09T09:14:00Z" }).last_update_at)
      .toBe("2026-09-09T09:14:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// applyInstallPoll — the two opposite COALESCE rules
// ---------------------------------------------------------------------------

describe("applyInstallPoll and the R3 columns (§13.4)", () => {
  it("COALESCEs the four update columns and disk, so a failure cannot be erased", async () => {
    responses = [[{ install_id: "install_a" }]];
    await M.applyInstallPoll({ install_id: "install_a" });
    const sqlText = calls[0].text;
    for (const column of [
      "last_update_result",
      "last_update_error",
      "last_update_at",
      "disk_free_bytes",
      "update_channel",
    ]) {
      expect(sqlText).toMatch(new RegExp(`${column}\\s*=\\s*COALESCE`));
    }
  });

  it("does NOT COALESCE session_open — it has to be able to go false (R3-3, R3-6)", async () => {
    responses = [[{ install_id: "install_a" }]];
    await M.applyInstallPoll({ install_id: "install_a", session_open: false });
    const sqlText = calls[0].text;
    expect(sqlText).toMatch(/session_open\s*=\s*\?::boolean/);
    expect(sqlText).not.toMatch(/session_open\s*=\s*COALESCE/);
    expect(calls[0].values).toContain(false);
  });

  it("a poll that omits everything writes nulls that COALESCE away", async () => {
    responses = [[{ install_id: "install_a" }]];
    await M.applyInstallPoll({ install_id: "install_a" });
    const f = M.cleanPollFields({ install_id: "install_a" });
    expect(f.last_update_result).toBeNull();
    expect(f.disk_free_bytes).toBeNull();
    // session_open included: null here means "not reported", which the card reads as silence.
    expect(f.session_open).toBeNull();
  });

  it("the fleet read selects every R3 column, or the card cannot render them", async () => {
    responses = [[], [], [], []];
    await M.readFleet(new Date("2026-09-09T10:00:00.000Z"));
    const installQuery = calls.find((c) => c.text.includes("LIMIT 500"));
    expect(installQuery).toBeDefined();
    for (const column of [
      "session_open",
      "update_channel",
      "last_update_result",
      "last_update_version",
      "last_update_error",
      "last_update_at",
      "disk_free_bytes",
    ]) {
      expect(installQuery!.text).toContain(column);
    }
  });

  it("reads BOTH channels' releases, not just stable (Fix 1, F6)", async () => {
    responses = [[], [], [], []];
    const payload = await M.readFleet(new Date("2026-09-09T10:00:00.000Z"));
    const releaseQueries = calls.filter((c) => c.text.includes("FROM app_release"));
    expect(releaseQueries).toHaveLength(2);
    expect(releaseQueries.flatMap((c) => c.values)).toEqual(
      expect.arrayContaining(["stable", "test"]),
    );
    expect(payload.releases).toEqual({ stable: null, test: null });
  });
});

// ---------------------------------------------------------------------------
// Migration 0078
// ---------------------------------------------------------------------------

describe("migration 0078", () => {
  const sqlText = readFileSync("db/migrations/0078_install_update_fields.sql", "utf8");

  it("records itself as version 78", () => {
    expect(sqlText).toMatch(/INSERT INTO schema_migrations \(version, name\)/);
    expect(sqlText).toMatch(/VALUES \(78, '0078_install_update_fields'\)/);
    expect(sqlText).toContain("ON CONFLICT DO NOTHING");
  });

  it("is additive and idempotent — every column is ADD COLUMN IF NOT EXISTS", () => {
    const ddl = sqlText.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    const adds = ddl.match(/ADD COLUMN IF NOT EXISTS/g) ?? [];
    expect(adds).toHaveLength(7);
    // Nothing is dropped, retyped or constrained. A migration that is safe whatever the applied
    // state of 0075-0077 turns out to be — which is not confirmed in production.
    expect(ddl).not.toMatch(/DROP |ALTER COLUMN |NOT VALID|CREATE UNIQUE/);
  });

  it("comments every column (house style of 0077)", () => {
    for (const column of [
      "session_open",
      "update_channel",
      "last_update_result",
      "last_update_error",
      "last_update_at",
      "disk_free_bytes",
    ]) {
      expect(sqlText).toContain(`COMMENT ON COLUMN room_install.${column}`);
    }
  });
});

// ---------------------------------------------------------------------------
// deriveRow — states A, B, C and E of the approved mockup delta
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-09T09:20:00.000Z");
const nowMs = NOW.getTime();
const ago = (ms: number) => new Date(nowMs - ms).toISOString();
const ahead = (ms: number) => new Date(nowMs + ms).toISOString();

const install = (over: Partial<V.InstallView> = {}): V.InstallView => ({
  install_id: "install_x4m8t2vc9de1",
  room_id: "room_1",
  created_at: ago(600_000),
  enrolled_at: ago(500_000),
  session_expires_at: ahead(358 * 86_400_000),
  launched_by: "launchd",
  hostname: "OPD-5-MINI",
  hardware_model: "Mac mini M2",
  os_version: "macOS 15.6",
  input_device_name: "TONOR TM20 Audio Device",
  app_version: "0.1.7",
  build_sha: "abc1234",
  first_seen_at: ago(500_000),
  last_seen_at: ago(8_000),
  mic_state: "authorized",
  launch_agent_loaded: true,
  tape_advancing: false,
  tape_poll_streak: 0,
  tape_advancing_since: null,
  never_sleep: true,
  retired_at: null,
  session_open: null,
  update_channel: "stable",
  last_update_result: null,
  last_update_version: null,
  last_update_error: null,
  last_update_at: null,
  disk_free_bytes: null,
  ...over,
});

const row = (i: V.InstallView | null): V.FleetRow => ({
  room_id: "room_1",
  room_slug: "opd-5-dr-salanki-wxmp",
  room_name: "OPD 5 Dr Salanki",
  disabled: false,
  install: i,
  pending: null,
  last_retired: null,
});

const derive = (i: V.InstallView | null, latestRelease: V.ReleaseView | null = null) =>
  V.deriveRow({ row: row(i), latestRelease, nowMs });

describe("state A — an idle room stops being accused (R3-3)", () => {
  it("raises NO tape warning when the app says no session is open", () => {
    const view = derive(install({ session_open: false, tape_advancing: false }));
    expect(view.attention).toHaveLength(0);
    expect(view.state).toBe("healthy");
    expect(view.tape_label).toBe("idle, no session");
  });

  it("says nothing about the tape when the app cannot tell (session_open null)", () => {
    // Every install below 0.1.8 reports null here, for ever. Null is "I cannot tell", which is not
    // grounds for an alarm on a clinical screen — and the warning it used to raise on an idle room
    // was false anyway.
    const view = derive(install({ session_open: null, tape_advancing: false }));
    expect(view.attention).toHaveLength(0);
    expect(view.tape_label).toBe("not advancing");
  });
});

describe("state B — the warning still works, unweakened", () => {
  it("fires when a session IS open and the tape is not advancing", () => {
    const view = derive(install({ session_open: true, tape_advancing: false }));
    expect(view.attention).toContain(
      "Tape not advancing. The room is not putting audio on the day tape.",
    );
    expect(view.state).toBe("needs_attention");
    expect(view.tape_label).toBe("recording, not advancing");
  });

  it("stays quiet when a session is open and audio IS arriving", () => {
    const view = derive(install({ session_open: true, tape_advancing: true }));
    expect(view.attention).toHaveLength(0);
    expect(view.tape_label).toBe("advancing");
  });

  it("an unreachable Mac still names the silence once, not twice", () => {
    const view = derive(
      install({ session_open: true, tape_advancing: false, last_seen_at: ago(20 * 60_000) }),
    );
    expect(view.attention).toHaveLength(1);
    expect(view.attention[0]).toMatch(/No poll from this Mac/);
  });
});

describe("state C — a failed update names itself in the App cell (R3-7)", () => {
  const failed = (over: Partial<V.InstallView> = {}) =>
    derive(
      install({
        session_open: false,
        tape_advancing: true,
        last_update_result: "checksum_mismatch",
        last_update_version: "0.1.8",
        last_update_error: "the downloaded file did not match its checksum",
        last_update_at: "2026-09-09T09:14:00.000Z",
        ...over,
      }),
    );

  it("renders the mockup's sentence, in the App cell, with the version that failed", () => {
    const view = failed();
    expect(view.update_note).toBe(
      "Update to 0.1.8 stopped at 14:44. The downloaded file did not match its checksum. This Mac still runs 0.1.7 and is still recording.",
    );
    expect(view.update_failed).toBe(true);
  });

  it("puts the sentence in the App cell and NOT in the attention list — state D does not ship", () => {
    const view = failed();
    expect(view.attention).not.toContain(view.update_note);
    expect(view.attention.some((a) => a.includes("Update to"))).toBe(false);
  });

  it("marks the row for attention, as the approved mockup draws it", () => {
    expect(failed().state).toBe("needs_attention");
  });

  it("uses the mockup's own words for an unsigned download", () => {
    const view = failed({
      last_update_result: "signature_mismatch",
      last_update_error: "the downloaded app was not signed by Even",
    });
    expect(view.update_note).toContain("The downloaded app was not signed by Even.");
  });

  it("renders the version_mismatch sentence too (Fix 2, G1)", () => {
    // The fault is on the shelf, not on the Mac: the bundle is authentic and correctly signed, it
    // is simply labelled wrong. The sentence says so without calling the download broken.
    const view = failed({
      last_update_result: "version_mismatch",
      last_update_error: "the downloaded app calls itself 0.1.9 but the release is named 0.1.8",
    });
    expect(view.update_note).toBe(
      "Update to 0.1.8 stopped at 14:44. The downloaded app was published as a different version "
        + "from the one it says it is. This Mac still runs 0.1.7 and is still recording.",
    );
    expect(view.update_failed).toBe(true);
  });

  it("shows NOTHING new when the last update worked, or when none was attempted", () => {
    for (const r of ["ok", null] as const) {
      const view = derive(install({ session_open: false, tape_advancing: true, last_update_result: r }));
      expect(view.update_note).toBeNull();
      expect(view.update_failed).toBe(false);
      expect(view.state).toBe("healthy");
    }
  });

  it("degrades to a shorter TRUE sentence when no version was recorded", () => {
    // A receipt from before Fix 1, or one whose version the server rejected as not version-shaped,
    // still deserves a report — just a shorter one. Never an invented version.
    const view = failed({ last_update_version: null });
    expect(view.update_note).toContain("Update stopped at");
    expect(view.update_note).not.toMatch(/Update to \S+ stopped/);
  });

  it("still reports an outcome this build has no words for", () => {
    const view = failed({ last_update_result: "moon_phase_wrong" as never });
    expect(view.update_note).toContain("moon_phase_wrong");
    expect(view.update_failed).toBe(true);
  });
});

describe("state E — the channel valve (R3-8)", () => {
  it("shows the channel from the Mac's own config, on the row", () => {
    expect(derive(install({ update_channel: "test" })).channel_label).toBe("channel test");
    expect(derive(install({ update_channel: "stable" })).channel_label).toBe("channel stable");
    expect(derive(install({ update_channel: null })).channel_label).toBeNull();
  });

  it("does not tell a test-channel Mac it is behind the STABLE release", () => {
    const rel = { version: "0.1.8", withdrawn_at: null } as V.ReleaseView;
    expect(derive(install({ update_channel: "test", app_version: "0.1.9-test" }), rel).version_hint)
      .toBe("test channel");
    expect(derive(install({ update_channel: "stable", app_version: "0.1.7" }), rel).version_hint)
      .toBe("latest 0.1.8");
    expect(derive(install({ update_channel: "stable", app_version: "0.1.8" }), rel).version_hint)
      .toBe("latest");
  });

  it("says nothing at all about the version when the row's channel has no release (F6)", () => {
    // "latest" against an empty shelf would assert the Mac is up to date with nothing.
    expect(derive(install({ update_channel: "stable", app_version: "0.1.7" }), null).version_hint)
      .toBeNull();
  });
});

describe("update pending is measured against the row's OWN channel (Fix 1, F6)", () => {
  const stable = { version: "0.1.8", withdrawn_at: null } as V.ReleaseView;
  const test = { version: "0.1.9-test", withdrawn_at: null } as V.ReleaseView;

  it("does NOT fire on a test-channel Mac just because stable moved", () => {
    // THE BUG THIS CLOSES: `readFleet` read only `latestRelease("stable")` and `deriveRow`
    // compared every row against it, so Home Office on `test` would have worn `update pending`
    // for ever against a build it is never offered. The approved mockup's state E draws it with
    // no such pill.
    const homeOffice = row(install({ update_channel: "test", app_version: "0.1.9-test" }));
    const forRow = V.releaseForRow(homeOffice, { stable, test });
    const view = V.deriveRow({ row: homeOffice, latestRelease: forRow, nowMs });
    expect(view.words).not.toContain("update pending");
  });

  it("DOES fire on a test-channel Mac that is behind its own channel", () => {
    const homeOffice = row(install({ update_channel: "test", app_version: "0.1.8-test" }));
    const forRow = V.releaseForRow(homeOffice, { stable, test });
    expect(V.deriveRow({ row: homeOffice, latestRelease: forRow, nowMs }).words)
      .toContain("update pending");
  });

  it("still fires on a stable Mac that is behind stable", () => {
    const clinic = row(install({ update_channel: "stable", app_version: "0.1.7" }));
    const forRow = V.releaseForRow(clinic, { stable, test });
    expect(V.deriveRow({ row: clinic, latestRelease: forRow, nowMs }).words)
      .toContain("update pending");
  });

  it("never fires when the row's channel has nothing published", () => {
    const homeOffice = row(install({ update_channel: "test", app_version: "0.1.8-test" }));
    const forRow = V.releaseForRow(homeOffice, { stable, test: null });
    expect(forRow).toBeNull();
    expect(V.deriveRow({ row: homeOffice, latestRelease: forRow, nowMs }).words)
      .not.toContain("update pending");
  });

  it("picks stable for a row with no install and for one that reports no channel", () => {
    // Every install predating R3 is on stable by construction.
    expect(V.releaseForRow(row(null), { stable, test })).toBe(stable);
    expect(V.releaseForRow(row(install({ update_channel: null })), { stable, test })).toBe(stable);
  });
});

describe("free disk in the Machine cell (V, 9 Sep)", () => {
  it("renders a human size, and nothing at all when it was not reported", () => {
    expect(derive(install({ disk_free_bytes: 412_300_000_000 })).disk_label).toBe("412.3 GB free");
    expect(derive(install({ disk_free_bytes: 1_500_000_000_000 })).disk_label).toBe("1.50 TB free");
    expect(derive(install({ disk_free_bytes: 800_000_000 })).disk_label).toBe("800 MB free");
    expect(derive(install({ disk_free_bytes: null })).disk_label).toBeNull();
    // 0 can never arrive — the app omits the field — but if it ever did, it must not render as
    // "0 MB free" on a clinical screen.
    expect(derive(install({ disk_free_bytes: 0 })).disk_label).toBeNull();
  });
});

describe("the attempted version is a column, not a parsed prefix (Fix 1, F5)", () => {
  it("is sanitised to something version-shaped, or dropped", () => {
    // The card renders it inside a sentence, so a Mac must not be able to put arbitrary text on a
    // clinical screen through it.
    for (const ok of ["0.1.8", "0.1.9-test", "1.0", "10.20.30.40"]) {
      expect(M.cleanPollFields({ install_id: "i", last_update_version: ok }).last_update_version)
        .toBe(ok);
    }
    for (const bad of ["", "latest", "0.1.8; DROP", "<b>0.1.8</b>", "v0.1.8", "0"]) {
      expect(M.cleanPollFields({ install_id: "i", last_update_version: bad }).last_update_version)
        .toBeNull();
    }
  });

  it("COALESCEs like the rest of the receipt", async () => {
    responses = [[{ install_id: "install_a" }]];
    await M.applyInstallPoll({ install_id: "install_a" });
    expect(calls[0].text).toMatch(/last_update_version\s*=\s*COALESCE/);
  });

  it("the reason line no longer carries a packed version", () => {
    // The delimiter and its reader are gone. Nothing parses free text any more.
    expect((V as Record<string, unknown>).attemptedVersion).toBeUndefined();
    expect((V as Record<string, unknown>).UPDATE_ERROR_SEPARATOR).toBeUndefined();
  });
});
