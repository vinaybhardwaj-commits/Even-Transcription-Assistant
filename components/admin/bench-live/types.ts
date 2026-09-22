import type { ActiveMicAlert, OperationalAlert, Stranded } from "@/lib/room-facts";

export type Level = "ok" | "amber" | "red" | "unknown";
export type LaneLevel = "ok" | "amber" | "red" | "off";
export type LaneView = { level: LaneLevel; state: string; enabled: boolean | null; note?: string };
export type DaySummary = {
  audio_recorded_ms: number;
  turned_into_words_ms: number;
  gave_up: number;
  visits_built: number;
  stranded?: Stranded;
};
export type Levels = { peak: number; avg: number } | null;

export type ListenerRowView = {
  room_id: string;
  room_slug: string;
  room_name: string;
  listening: boolean;
  age_ms: number;
  paused: boolean;
  recording_session_id: string | null;
  tab_id: string;
  last_poll_at: string;
  mic?: Levels;
  spare?: Levels;
  levels_at?: string | null;
  spare_device?: boolean;
};

export type ListenersResp = {
  now: string;
  freshness_window_ms: number;
  listeners: ListenerRowView[];
  degraded?: string[];
};

export type RoomLive = {
  room: { id: string; slug: string; name: string };
  recording: boolean;
  paused_session: boolean;
  session_id: string | null;
  session_started_at: string | null;
  last_primary_at: string | null;
  last_backup_at: string | null;
  last_piece_at: string | null;
  mic_level: Level;
  backup_chunks_today: number;
  backup_reads_no_chunks: boolean;
  mic_size?: { newest: "ok" | "tiny" | "unknown"; tiny_run: number; proven_dead_by_size: boolean; baseline_bytes_per_ms: number | null } | null;
  spare_size?: { newest: "ok" | "tiny" | "unknown"; tiny_run: number; proven_dead_by_size: boolean; baseline_bytes_per_ms: number | null } | null;
  spare_exists?: boolean;
  active_mic_alert?: ActiveMicAlert | null;
  tape_without_cues?: boolean | null;
  operational_alerts?: OperationalAlert[];
  stalled: boolean;
  stalled_age_ms: number | null;
  transcript_enabled: boolean;
  visits_enabled: boolean;
  transcript_counts: { done: number; waiting: number; no_day: number; in_progress: number; failed: number; words_ms: number };
  has_room_day_today: boolean | null;
  visit_counts: { built: number; open: number };
  stranded?: Stranded;
  audio_recorded_ms?: number;
  lanes: { tape: LaneView; transcript: LaneView; visits: LaneView };
  ended_disagrees: boolean;
  ended_disagrees_session_id: string | null;
  ended_disagrees_ended_at: string | null;
  ended_disagrees_last_piece_at: string | null;
  ended_disagrees_chunks: number;
  ended_at_lies?: boolean;
  ended_at_lies_sessions?: string[];
  last_session_ended?: boolean;
  last_warehouse_at: string | null;
  has_doctor_clock?: boolean;
  doctor_clock_silent_ms: number | null;
  doctor_clock_level: Level;
  marks_today: number;
  last_mark_at: string | null;
  marks_not_sent: number;
  last_window_asked_at: string | null;
  last_window_complete: boolean | null;
  degraded: string[];
};

export type RoomsLiveResp = {
  ist_date: string;
  now: string;
  day?: DaySummary;
  rooms: RoomLive[];
  thresholds?: {
    mic_amber_ms: number;
    mic_red_ms: number;
    doctor_clock_amber_ms: number;
    doctor_clock_red_ms: number;
    listener_fresh_ms: number;
    stall_minutes: number;
  };
  degraded?: string[];
};

export type PendingCommandView = {
  id: string;
  room_id: string;
  kind: string;
  status: "pending";
  created_at: string;
};

export type Attention = {
  roomId: string;
  room: string;
  severity: "red" | "amber";
  title: string;
  detail: string;
};
