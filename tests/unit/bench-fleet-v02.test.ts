import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { roomOperationalAlerts } from "@/lib/room-facts";

const source = (path: string) => readFileSync(path, "utf8");

describe("Fleet board v0.2 command contract", () => {
  it("listener-gates every non-start kiosk command before inserting it", () => {
    const route = source("app/api/admin/bench/command/route.ts");
    const gate = route.indexOf("const listener = await getListener(roomId)");
    const insert = route.indexOf("const id = await insertCommand({ roomId, kind, source: \"admin\" })");
    expect(gate).toBeGreaterThan(0);
    expect(insert).toBeGreaterThan(gate);
    expect(route.slice(gate, insert)).toContain("if (!isListening(listener))");
    expect(route.slice(gate, insert)).toContain('return fail(409, "kiosk_not_listening"');
    expect(route.slice(gate, insert)).toContain("queued: false");
  });

  it("exposes pending bus rows and polls them with listener health", () => {
    expect(source("app/api/admin/bench/command/route.ts")).toContain('status === "pending" || status === "recent"');
    expect(source("components/admin/bench-live/useBenchLivePolling.ts"))
      .toContain('/api/admin/bench/command?status=recent');
  });

  it("guards terminal updates by command id so stale watchers cannot win", () => {
    const ui = source("components/admin/BenchRoomsLive.tsx");
    expect(ui).toContain("prev[roomId]?.commandId !== commandId");
    expect(ui).toContain("no previous command outcome applies");
  });
});

describe("Fleet board v0.2 facts and IA", () => {
  it("surfaces paused disagreement from the shared room-facts contract", () => {
    const alerts = roomOperationalAlerts({
      recording: true,
      kioskListening: true,
      stalled: false,
      stalledAgeMs: null,
      activeMicAlert: null,
      tapeWithoutCues: false,
      pausedDisagrees: true,
    });
    expect(alerts).toContainEqual(expect.objectContaining({
      code: "paused_disagrees",
      severity: "amber",
      label: "Pause state disagrees",
    }));
  });

  it("keeps the default route fleet-only and moves desk work to an archive route", () => {
    const page = source("app/admin/bench/page.tsx");
    expect(page).toContain("<BenchRoomsLive />");
    expect(page).not.toContain("<BenchClient />");
    expect(source("app/admin/bench/archive/page.tsx")).toContain("<BenchClient />");
  });

  it("keeps archive history room-keyed and discloses the API's 200-session cap", () => {
    const archive = source("components/admin/BenchClient.tsx");
    expect(archive).toContain("Choose room recordings");
    expect(archive).toContain("selectedRoom.choose(room.id)");
    expect(archive).toContain("Showing the newest {SESSION_LIST_CAP} sessions across all rooms");
    expect(archive).toContain("Older recordings may not appear here");
  });

  it("has focused polling, attention, card, danger-zone, and day-summary boundaries", () => {
    for (const path of [
      "components/admin/bench-live/useBenchLivePolling.ts",
      "components/admin/bench-live/BenchAttentionList.tsx",
      "components/admin/bench-live/RoomCard.tsx",
      "components/admin/bench-live/BenchDangerZone.tsx",
      "components/admin/bench-live/BenchDaySummary.tsx",
    ]) {
      expect(source(path).length, path).toBeGreaterThan(100);
    }
  });
});
