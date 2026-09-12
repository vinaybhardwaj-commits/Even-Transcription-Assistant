/**
 * Tier 1 §3 (D1 amended) — `assigned_channel` may carry `test`.
 *
 * The route writes it; the real poll route hands it back to the Mac in the same response shape B2
 * used for `stable`; and the assignment clears itself only on the poll where the Mac reports the
 * ASSIGNED channel. The clear is evaluated here from the UPDATE's own text (the fake reads the CASE
 * the statement actually carries), so a return to B2's stable-only form would fail this file: under
 * it, a stable Mac's first poll would clear a test assignment before the Mac could act on it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

type Row = Record<string, unknown>;
const calls: Array<{ text: string; values: unknown[] }> = [];
const store: { install: Row } = { install: {} };

/** Just enough of Postgres for this statement: the assignment's CASE, and RETURNING. */
function applyPollUpdate(strings: TemplateStringsArray, values: unknown[]): Row[] {
  if (store.install.retired_at) return [];
  const before = { ...store.install };
  for (let k = 0; k < values.length; k++) {
    const pre = strings[k]!;
    const post = strings[k + 1] ?? "";
    if (/assigned_channel\s*=\s*CASE WHEN\s*$/.test(pre)) {
      const byColumn = /^::text = assigned_channel THEN NULL ELSE assigned_channel END/.test(post);
      const byLiteral = /^::text = '(\w+)' THEN NULL ELSE assigned_channel END/.exec(post);
      const v = values[k];
      if (byColumn && v !== null && v !== undefined && v === before.assigned_channel) store.install.assigned_channel = null;
      if (byLiteral && v === byLiteral[1]) store.install.assigned_channel = null;
    }
    if (/update_channel\s*=\s*COALESCE\(\s*$/.test(pre) && values[k] != null) store.install.update_channel = values[k];
  }
  return [{ install_id: store.install.install_id, assigned_channel: store.install.assigned_channel ?? null }];
}

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    if (/^UPDATE room_install SET last_seen_at/.test(text)) return Promise.resolve(applyPollUpdate(strings, values));
    if (/^UPDATE room_install SET assigned_channel = \?/.test(text)) {
      if (store.install.retired_at || values[1] !== store.install.install_id) return Promise.resolve([]);
      store.install.assigned_channel = values[0];
      return Promise.resolve([{ install_id: store.install.install_id, assigned_channel: values[0] }]);
    }
    return Promise.resolve([]);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});
vi.mock("@/lib/cookie", () => ({ readAdminCookie: async () => null }));
vi.mock("@/lib/room-auth", () => ({ readRoomClaims: async () => ({ room_id: "room_home" }) }));

process.env.MIGRATION_SECRET = "test-secret";
const assign = await import("@/app/api/admin/installs/[installId]/assign-channel/route");
const commands = await import("@/app/api/bench/commands/route");
const V = await import("@/lib/room-install-view");
const { FleetTable } = await import("@/components/admin/BenchInstallFleet");

beforeEach(() => {
  calls.length = 0;
  store.install = { install_id: "install_home", assigned_channel: null, update_channel: "stable", retired_at: null };
});

const assignTo = async (channel: unknown, id = "install_home") => {
  const req = new Request("https://www.evenscribe.app/api/admin/installs/x/assign-channel", {
    method: "POST",
    headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
    body: JSON.stringify({ channel }),
  });
  const res = await assign.POST(req as never, { params: Promise.resolve({ installId: id }) });
  return { status: res.status, json: (await res.json()) as Row };
};

const poll = async (q: Record<string, string>) => {
  const url = new URL("https://www.evenscribe.app/api/bench/commands");
  for (const [k, v] of Object.entries({ tab_id: "app_install_home", install_id: "install_home", ...q })) url.searchParams.set(k, v);
  const res = await commands.GET({ nextUrl: url } as never);
  return (await res.json()) as Row;
};

describe("assign-channel writes test", () => {
  it("answers 200 with the assignment and writes exactly that value", async () => {
    const { status, json } = await assignTo("test");
    expect(status).toBe(200);
    expect(json).toEqual({ install_id: "install_home", assigned_channel: "test" });
    const w = calls.find((c) => /SET assigned_channel = \?/.test(c.text))!;
    expect(w.values).toEqual(["test", "install_home"]);
  });

  it("still refuses anything that is not exactly stable or test", async () => {
    for (const bad of ["TEST", "beta", "", null, ["test"]]) {
      expect((await assignTo(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(calls.filter((c) => /SET assigned_channel/.test(c.text))).toHaveLength(0);
  });

  it("404 for a retired install", async () => {
    store.install.retired_at = "2026-09-11T00:00:00Z";
    expect((await assignTo("test")).status).toBe(404);
  });
});

describe("the poll carries test back, and clears it only when the Mac reports test", () => {
  it("round-trips: assigned test, a stable Mac is TOLD test on every poll until it reports test", async () => {
    await assignTo("test");
    // The Mac is still on stable: it is told test, and a stable report does NOT clear a test assignment.
    expect((await poll({ update_channel: "stable" })).assigned_channel).toBe("test");
    expect((await poll({ update_channel: "stable" })).assigned_channel).toBe("test");
    // A poll that says nothing about its channel clears nothing.
    expect((await poll({ app_version: "0.1.22" })).assigned_channel).toBe("test");
    // The Mac reports test of its own accord: the same round trip is told null, and the row holds null.
    expect((await poll({ update_channel: "test" })).assigned_channel).toBeNull();
    expect(store.install.assigned_channel).toBeNull();
    // A later hand move back to stable is left alone.
    expect((await poll({ update_channel: "stable" })).assigned_channel).toBeNull();
  });

  it("B2's own case still holds: assigned stable clears when the Mac reports stable, not test", async () => {
    store.install.update_channel = "test";
    await assignTo("stable");
    expect((await poll({ update_channel: "test" })).assigned_channel).toBe("stable");
    expect((await poll({ update_channel: "stable" })).assigned_channel).toBeNull();
  });
});

describe("the card", () => {
  it("shows `channel locked` when the Mac reports it, and a retired row never does", () => {
    const install = { install_id: "install_home", room_id: "room_home", enrolled_at: "x", retired_at: null, channel_locked: true } as unknown as import("@/lib/room-install-view").InstallView;
    const row = { room_id: "room_home", room_slug: "s", room_name: "Home Office", disabled: false, install, pending: null, last_retired: null } as import("@/lib/room-install-view").FleetRow;
    expect(V.deriveRow({ row, latestRelease: null, nowMs: Date.now() }).channel_locked).toBe(true);
    expect(V.deriveRow({ row: { ...row, install: { ...install, channel_locked: null } }, latestRelease: null, nowMs: Date.now() }).channel_locked).toBe(false);
    expect(V.deriveRow({ row: { ...row, install: { ...install, retired_at: "2026-09-11T00:00:00Z" } }, latestRelease: null, nowMs: Date.now() }).channel_locked).toBe(false);
    const html = renderToStaticMarkup(
      React.createElement(FleetTable, {
        fleet: { now: new Date().toISOString(), rows: [row], latest_release: null, releases: { stable: null, test: null }, degraded: [] } as import("@/lib/room-install-view").FleetPayload,
        nowMs: Date.now(), busy: null, onCopy: () => {}, onRetire: () => {}, onAssignStable: () => {}, onSetAudioInput: () => {},
      }),
    );
    expect(html).toContain("data-channel-locked");
    expect(html).toContain("channel locked");
  });

  // ── orchestrator fix-up ruling, seam 15 ─────────────────────────────────────────────────
  // Both strings were written when `stable` was the only assignable channel. Tier 1 §3 made
  // `test` assignable, so a line that names the destination and a tooltip that promises the
  // server never assigns `test` are both claims the card can no longer make.
  it("the pending line and the Move-to-stable tooltip say nothing about which channel is assignable", () => {
    const mk = (over: Record<string, unknown>) => {
      const install = { install_id: "install_home", room_id: "room_home", enrolled_at: "x", retired_at: null, ...over } as unknown as import("@/lib/room-install-view").InstallView;
      return { room_id: "room_home", room_slug: "s", room_name: "Home Office", disabled: false, install, pending: null, last_retired: null } as import("@/lib/room-install-view").FleetRow;
    };
    // One row waiting on an assignment, one row offering the move: both strings in one render.
    const rows = [mk({ assigned_channel: "stable", update_channel: "test" }), mk({ assigned_channel: null, update_channel: "test" })];
    expect(V.deriveRow({ row: rows[0]!, latestRelease: null, nowMs: Date.now() }).assigned_pending).toBe(true);
    expect(V.deriveRow({ row: rows[1]!, latestRelease: null, nowMs: Date.now() }).can_move_to_stable).toBe(true);
    // 12 Sep ruling: the line the neutral wording was written for. A pending TEST assignment now
    // renders it too — under the stable-only rule this row said nothing at all.
    const pendingTest = mk({ assigned_channel: "test", update_channel: "stable" });
    expect(V.deriveRow({ row: pendingTest, latestRelease: null, nowMs: Date.now() }).assigned_pending).toBe(true);
    rows.push(pendingTest);
    const html = renderToStaticMarkup(
      React.createElement(FleetTable, {
        fleet: { now: new Date().toISOString(), rows, latest_release: null, releases: { stable: null, test: null }, degraded: [] } as import("@/lib/room-install-view").FleetPayload,
        nowMs: Date.now(), busy: null, onCopy: () => {}, onRetire: () => {}, onAssignStable: () => {}, onSetAudioInput: () => {},
      }),
    );
    // The strings that are actually rendered now.
    expect(html).toContain("channel assigned · waiting for the Mac");
    expect(html).toContain("Only the Mac&#x27;s own report proves it moved.");
    // The two stale ones are gone, and neither may come back.
    expect(html).not.toContain("assigned stable · waiting for the Mac");
    expect(html).not.toContain("The server never moves a Mac onto test");
  });
});
