import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { attentionItems } from "@/components/admin/BenchRoomsLive";
import {
  resolveRoomQuery,
  roomSelectionUrl,
} from "@/components/admin/bench-live/roomSelection";
import type {
  ListenerRowView,
  RoomLive,
} from "@/components/admin/bench-live/types";
import {
  hostCloudDesync,
  roomOperationalAlerts,
  tapeLane,
  transcriptLane,
  visitsLane,
} from "@/lib/room-facts";

const NOW = Date.parse("2026-09-22T07:00:00.000Z");
const NONE = {
  done: 0,
  waiting: 0,
  no_day: 0,
  in_progress: 0,
  failed: 0,
  words_ms: 0,
};

const room = (over: Partial<RoomLive> = {}): RoomLive => ({
  room: { id: "room_a", slug: "cardio", name: "Cardiology" },
  recording: true,
  paused_session: false,
  session_id: "bs_cloud",
  session_started_at: new Date(NOW - 60_000).toISOString(),
  last_primary_at: new Date(NOW - 60_000).toISOString(),
  last_backup_at: null,
  last_piece_at: new Date(NOW - 60_000).toISOString(),
  mic_level: "ok",
  backup_chunks_today: 0,
  backup_reads_no_chunks: false,
  active_mic_alert: null,
  tape_without_cues: false,
  stalled: false,
  stalled_age_ms: null,
  transcript_enabled: true,
  visits_enabled: false,
  transcript_counts: NONE,
  has_room_day_today: true,
  visit_counts: { built: 0, open: 0 },
  lanes: {
    tape: tapeLane({
      recording: true,
      paused_session: false,
      stalled: false,
      stalled_age_ms: null,
      session_started_at: null,
      primary_chunks: 1,
      nowMs: NOW,
    }),
    transcript: transcriptLane(true, NONE),
    visits: visitsLane(false, { built: 0, open: 0 }),
  },
  ended_disagrees: false,
  ended_disagrees_session_id: null,
  ended_disagrees_ended_at: null,
  ended_disagrees_last_piece_at: null,
  ended_disagrees_chunks: 0,
  last_warehouse_at: null,
  doctor_clock_silent_ms: null,
  doctor_clock_level: "unknown",
  marks_today: 0,
  last_mark_at: null,
  marks_not_sent: 0,
  last_window_asked_at: null,
  last_window_complete: null,
  degraded: [],
  ...over,
});

const listener = (over: Partial<ListenerRowView> = {}): ListenerRowView => ({
  room_id: "room_a",
  room_slug: "cardio",
  room_name: "Cardiology",
  listening: true,
  age_ms: 1_000,
  paused: false,
  recording_session_id: "bs_cloud",
  tab_id: "tab_a",
  last_poll_at: new Date(NOW - 1_000).toISOString(),
  ...over,
});

describe("Bench fleet v0.3 attention promotion", () => {
  it.each([
    ["device_missing", "Device missing"],
    ["digital_silence", "Recording is digitally silent"],
    ["encoder_stalled", "Encoder stalled"],
  ] as const)("promotes %s from room-facts into attention", (activeMicAlert, title) => {
    const items = attentionItems(
      [room({ active_mic_alert: activeMicAlert })],
      new Map([["room_a", listener()]]),
      true,
      NOW,
    );
    expect(items[0]).toMatchObject({ title, severity: "red", rank: 0 });
  });

  it("keeps tape-risk above safe transcript backlog", () => {
    const items = attentionItems(
      [
        room({
          active_mic_alert: "device_missing",
          transcript_counts: { ...NONE, waiting: 3 },
        }),
      ],
      new Map([["room_a", listener()]]),
      true,
      NOW,
    );
    expect(items.map((item) => item.title)).toEqual([
      "Device missing",
      expect.stringContaining("the audio is safe"),
    ]);
  });

  it("detects fresh host/cloud session mismatch and preserves unknown", () => {
    expect(hostCloudDesync({
      listenerKnown: true,
      kioskListening: true,
      hostSessionId: "bs_host",
      cloudSessionId: "bs_cloud",
    })).toBe(true);
    expect(hostCloudDesync({
      listenerKnown: false,
      kioskListening: false,
      hostSessionId: null,
      cloudSessionId: "bs_cloud",
    })).toBeNull();
    expect(roomOperationalAlerts({
      recording: true,
      kioskListening: true,
      stalled: false,
      stalledAgeMs: null,
      activeMicAlert: null,
      tapeWithoutCues: false,
      hostCloudDesync: true,
    })).toContainEqual(expect.objectContaining({
      code: "host_cloud_desync",
      label: "Host and cloud recording disagree",
    }));
  });
});

describe("Bench fleet v0.3 room focus query", () => {
  const rooms = [
    room(),
    room({ room: { id: "room_b", slug: "dietary", name: "Dietary" } }),
  ];

  it("opens a room by slug or id and treats an invalid room as non-fatal", () => {
    expect(resolveRoomQuery(rooms, "?room=dietary")).toMatchObject({
      kind: "match",
      room: { room: { id: "room_b" } },
    });
    expect(resolveRoomQuery(rooms, "?room=room_a")).toMatchObject({
      kind: "match",
      room: { room: { slug: "cardio" } },
    });
    expect(resolveRoomQuery(rooms, "?room=missing")).toEqual({
      kind: "invalid",
      value: "missing",
    });
  });

  it("writes the selected room into the URL and renders the focus panel", () => {
    expect(
      roomSelectionUrl(
        "https://www.evenscribe.app/admin/bench?foo=1#fleet",
        rooms[1]!.room,
      ),
    ).toBe("/admin/bench?foo=1&room=dietary#fleet");
    const source = readFileSync(
      "components/admin/bench-live/BenchRoomFocus.tsx",
      "utf8",
    );
    expect(source).toContain('data-testid="room-focus-panel"');
    expect(source).toContain("<BenchCommandTransport");
    expect(source).toContain("<BenchRoomVitals");
  });
});
