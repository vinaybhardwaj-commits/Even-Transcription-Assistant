/**
 * ADMIN-5 — skipAudit on the GATING functions: it skips ONLY their own audit_log insert. The alert still queues; the default (false) still writes the row, so the Bench route,
 * the /admin retire route and the PIN lockout are unchanged. `sql` is a small fake that records statements.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const stmts: Array<{ q: string; values: unknown[] }> = [];
const alerts: Row[] = [];
vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ").trim();
    stmts.push({ q, values });
    if (/^SELECT slug, disabled_at FROM room/.test(q)) return Promise.resolve([{ slug: "opd-4-abcd", disabled_at: null }]);
    if (/^SELECT slug, name FROM room/.test(q) || /^SELECT name FROM room/.test(q)) return Promise.resolve([{ slug: "opd-4-abcd", name: "OPD 4" }]);
    if (/^UPDATE room_install SET retired_at = now\(\)/.test(q)) return Promise.resolve([{ install_id: "inst_1", room_id: "room_a", created_at: new Date().toISOString(), enrolled_at: null, retired_at: new Date().toISOString(), last_seen_at: null, last_seen_age_s: null }]);
    return Promise.resolve([]);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});
vi.mock("@/lib/alerts/ops-alert", () => ({ queueOpsAlert: async (a: Row) => { alerts.push(a); } }));
vi.mock("@/lib/alerts/clinic-hours", () => ({ isClinicHours: () => true }));

const { setRoomEnabled, recordRoomToggle } = await import("@/lib/room-enable");
const { retireInstall } = await import("@/lib/room-install");

const auditInserts = () => stmts.filter((s) => /^INSERT INTO audit_log/.test(s.q));
beforeEach(() => { stmts.length = 0; alerts.length = 0; });

describe("setRoomEnabled / recordRoomToggle", () => {
  it("default: writes its room.disable audit row and queues the clinic-hours alert", async () => {
    await setRoomEnabled("room_a", false, { actor: "adm_1", reason: "r" });
    expect(auditInserts()).toHaveLength(1);
    expect(auditInserts()[0]!.values).toContain("room.disable");
    expect(alerts.map((a) => a.kind)).toEqual(["room_disabled"]);
  });
  it("skipAudit: no audit insert, the alert still queues", async () => {
    await setRoomEnabled("room_a", false, { actor: "mcp:admin:x", reason: "r", skipAudit: true });
    expect(auditInserts()).toHaveLength(0);
    expect(alerts.map((a) => a.kind)).toEqual(["room_disabled"]);
  });
  it("recordRoomToggle: the PIN-lockout style call (no skipAudit) still writes its row", async () => {
    await recordRoomToggle({ room_id: "room_a", room_slug: "opd-4-abcd", before: "enabled", after: "disabled", actor: "system:pin_lockout" });
    expect(auditInserts()).toHaveLength(1);
  });
});

describe("retireInstall", () => {
  it("default: writes install.retire and queues install_retired", async () => {
    const out = await retireInstall("inst_1", { actor: "adm_1" });
    expect(out.ok).toBe(true);
    expect(auditInserts()).toHaveLength(1);
    expect(auditInserts()[0]!.values).toContain("install.retire");
    expect(alerts.map((a) => a.kind)).toEqual(["install_retired"]);
  });
  it("skipAudit: no audit insert, the alert still queues", async () => {
    const out = await retireInstall("inst_1", { actor: "mcp:admin:x", skipAudit: true });
    expect(out.ok).toBe(true);
    expect(auditInserts()).toHaveLength(0);
    expect(alerts).toEqual([expect.objectContaining({ kind: "install_retired", install_id: "inst_1", room_id: "room_a", reason: "manual" })]);
  });
});
