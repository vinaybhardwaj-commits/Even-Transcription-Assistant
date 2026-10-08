/** Rooms Live v1.7: the card line, the Details log and the page strip render (server-side markup, no browser). */
import { describe, it, expect } from "vitest";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RoomTile } from "@/components/rooms-live/RoomTile";
import { RoomDetail } from "@/components/rooms-live/RoomDetail";
import type { RoomRow } from "@/lib/rooms-live/snapshot";

// vitest compiles the components with the classic JSX runtime (no tsconfig jsx transform here): give them the global they expect
(globalThis as { React?: unknown }).React = React;

const NOW = Date.parse("2026-10-08T12:50:00Z");
const base: RoomRow = {
  room_id: "room_ux92qpws", label: "OPD 4", doctor: { display: "Dr Test", activity: "Signed in" }, doctor_known: true, state: "listening", state_since: null, detail_code: null,
  level: { rms: 0.01, zero: 0.001, at: null, stale: false }, baseline_rms: 0.009, device: { name: "C270", missing: false }, session: { open: true, since: null, chunk_age_s: 30 },
  steward: null, steward_line: null, steward_log: [], claim: null, ages_s: { listener: 1, heartbeat: 1, ext: 1 },
};
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const tile = (row: RoomRow) => html(createElement(RoomTile, { row, nowMs: NOW, eng: false, onOpen: () => {} }));

describe("card line", () => {
  it("shows the Steward line under the status text when there is one, and nothing when there is none", () => {
    const withLine = tile({ ...base, steward_line: { text: "Steward would have restarted recording at 18:10 (watching only, not done)", at: "2026-10-08T12:40:00Z", mode: "shadow", outcome: "watching", kind: "action" } });
    expect(withLine).toContain("Steward would have restarted recording at 18:10 (watching only, not done)");
    expect(withLine).toContain('data-testid="steward-line"');
    expect(tile(base)).not.toContain("steward-line");
  });
  it("a payload from before v1.7 (no steward fields) still renders", () => {
    const { steward_line: _a, steward_log: _b, ...old } = base;
    expect(tile(old as RoomRow)).toContain("OPD 4");
  });
});

describe("Details: the room's last non-ok decisions", () => {
  const log = [
    { text: "Steward is holding restarts: the mic is missing", at: "2026-10-08T12:45:00Z", mode: "shadow" as const, outcome: "watching" as const, kind: "hold" as const },
    { text: "Steward started recording at 07:30", at: "2026-10-08T02:00:00Z", mode: "live" as const, outcome: "done" as const, kind: "action" as const },
  ];
  it("lists time (IST), sentence, mode and result", () => {
    const m = html(createElement(RoomDetail, { row: { ...base, steward_log: log }, nowMs: NOW, onClose: () => {} }));
    expect(m).toContain("What the Steward did");
    expect(m).toContain("18:15");
    expect(m).toContain("Steward is holding restarts: the mic is missing");
    expect(m).toContain("watching only");
    expect(m).toContain("07:30");
    expect(m).toContain("live · done");
  });
  it("says so when there is nothing", () => {
    expect(html(createElement(RoomDetail, { row: base, nowMs: NOW, onClose: () => {} }))).toContain("Nothing to report from the Steward.");
  });
});
