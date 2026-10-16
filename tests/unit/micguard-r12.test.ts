/**
 * M2: mic_guard rows (source mini_micguard_poller) must not enrol a Mac or stand in for a daemon heartbeat, so R12 (kiosk_health_silent) is unaffected.
 * The fake sql here emulates the exclusion: it returns the poller's rows only for a statement that does NOT carry the source exclusion.
 */
import { describe, it, expect } from "vitest";
import { readKioskHealth } from "@/lib/kiosk-health-read";
import { kioskHealthItems } from "@/lib/kiosk-health-rules";
import type { ExtHealthRow } from "@/lib/encounter-windows/ext-health";

const NOW = Date.parse("2026-10-06T05:30:00.000Z"); // 11:00 IST, clinic hours
const AS_OF = new Date(NOW).toISOString();
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();
const OPD_INSTALLED = "EHRC-OPD6s-Mac-mini";
const OPD_NOT_INSTALLED = "EHRC-OPD5s-Mac-mini";
const POLLER = "mini_micguard_poller";

function pollerRows(machine: string, state: string) {
  return { machine, room_id: "room_x", kind: "mic_guard", ts: ago(20), received_at: ago(20), payload: { state, reason: null, restored_today: 0 } };
}

function emulatingSql(rec: string[]) {
  const fn = (s: TemplateStringsArray, ...v: unknown[]) => {
    let q = "";
    s.forEach((p, k) => { q += p + (k < v.length ? `$${k + 1}` : ""); });
    rec.push(q);
    const excluded = q.includes(`k.source <> '${POLLER}'`);
    const isQ1 = q.includes("DISTINCT ON (k.machine, k.kind)");
    const isQ4 = q.includes("DISTINCT ON (k.machine) k.machine, k.received_at, k.kind");
    if (excluded) return Promise.resolve([]); // the only rows in the table are the poller's, so an excluding query sees nothing
    if (isQ1) return Promise.resolve([pollerRows(OPD_INSTALLED, "ok"), pollerRows(OPD_NOT_INSTALLED, "not_installed")]);
    if (isQ4) return Promise.resolve([
      { machine: OPD_INSTALLED, received_at: ago(20), kind: "mic_guard" },
      { machine: OPD_NOT_INSTALLED, received_at: ago(20), kind: "mic_guard" },
    ]);
    return Promise.resolve([]);
  };
  return fn as never;
}

const extOk = (machine: string): ExtHealthRow =>
  ({ machine, status: "ok", room_id: "room_x", room_name: "Room X" } as unknown as ExtHealthRow);

describe("M2 — mic_guard rows leave kiosk-health enrolment and R12 alone", () => {
  it("queries 1 and 4 exclude the poller source", async () => {
    const rec: string[] = [];
    await readKioskHealth(emulatingSql(rec), [OPD_INSTALLED, OPD_NOT_INSTALLED], AS_OF);
    const q1 = rec.find((q) => q.includes("DISTINCT ON (k.machine, k.kind)"))!;
    const q4 = rec.find((q) => q.includes("DISTINCT ON (k.machine) k.machine, k.received_at, k.kind"))!;
    expect(q1).toContain(`k.source <> '${POLLER}'`);
    expect(q4).toContain(`k.source <> '${POLLER}'`);
  });

  it("a machine whose only rows are mic_guard (installed room and installed:false room) is not enrolled and raises no R12 item", async () => {
    const { snapshots, ok } = await readKioskHealth(emulatingSql([]), [OPD_INSTALLED, OPD_NOT_INSTALLED], AS_OF);
    expect(ok).toBe(true);
    for (const m of [OPD_INSTALLED, OPD_NOT_INSTALLED]) expect(snapshots.get(m)?.enrolled ?? false).toBe(false);
    const ext = new Map([[OPD_INSTALLED, extOk(OPD_INSTALLED)], [OPD_NOT_INSTALLED, extOk(OPD_NOT_INSTALLED)]]);
    const items = kioskHealthItems(snapshots, ext, AS_OF, true);
    expect(items.filter((i) => i.kind === "kiosk_health_silent")).toEqual([]);
    expect(items).toEqual([]);
  });
});
