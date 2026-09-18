"use client";

import * as React from "react";
import type { RoomDayTape, TapeSlot, TapeTurn, BenchWindowState } from "@/lib/room-day/admin";

/**
 * `/admin/rooms/[roomId]/[date]` - the tape (S1 section 4-section 6).
 *
 * Fetches its own bundle from the one API route this build adds - the house pattern
 * (components/admin/EncounterDetailAdminClient.tsx:200-295). Every SIX bench_window states must
 * read as themselves (section 5.3): `closed` reads as "waiting", never as "nothing there"; `silent` reads
 * as a verdict, never as a gap. Voice numbers carry the UNRATIFIED threshold footnote (section 6.1);
 * every emotion number carries UNCALIBRATED (section 6.2), and the column reads "emotion surface off"
 * when the gate is false rather than disappearing.
 */

type FetchResp = { tape: RoomDayTape };

const STATE_STYLE: Record<BenchWindowState, string> = {
  open: "bg-even-blue-50 text-even-blue-700 border-even-blue-200",
  closed: "bg-even-ink-100 text-even-navy-800/70 border-even-ink-200",
  transcribing: "bg-amber-50 text-amber-700 border-amber-200",
  transcribed: "bg-green-50 text-green-700 border-green-200",
  failed: "bg-red-50 text-red-700 border-red-200",
  silent: "bg-purple-50 text-purple-700 border-purple-200",
};

const STATE_HINT: Record<BenchWindowState, string> = {
  open: "still recording",
  closed: "waiting to be drained - not yet processed",
  transcribing: "being transcribed right now",
  transcribed: "transcribed",
  failed: "transcription failed",
  silent: "the engine read this window and heard no speech - a verdict, not a gap",
};

function fmtPct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function TurnRow({ turn, surfaceEnabled }: { turn: TapeTurn; surfaceEnabled: boolean }) {
  const named = turn.voice.role === "clinician";
  return (
    <div className="border-t border-even-ink-100 py-2 first:border-t-0">
      <div className="flex items-start justify-between gap-3">
        <p className="text-caption text-even-navy-800 flex-1">
          {turn.text ?? <span className="italic text-even-ink-500">(no text joined for this turn)</span>}
        </p>
        <span className="text-[10px] text-even-ink-500 whitespace-nowrap">
          speaker {turn.speaker_idx}
        </span>
      </div>

      {/* Voice - E20's payoff. Named or the losing candidate; never both, per 0096's CHECKs. */}
      <p className="text-[11px] mt-1">
        {named ? (
          <span className="text-even-navy-800">
            {turn.voice.clinician_name ?? turn.voice.clinician_id} - match {turn.voice.match_confidence !== null ? fmtPct(turn.voice.match_confidence) : "-"}
          </span>
        ) : turn.voice.losing_score !== null ? (
          <span className="text-even-ink-500">
            not named - best candidate {turn.voice.losing_clinician_name ?? turn.voice.losing_clinician_id}, cosine {turn.voice.losing_score.toFixed(3)}
            {" "}
            <span className="uppercase text-[9px] tracking-wide">(raw cosine, not a confidence, threshold UNRATIFIED)</span>
          </span>
        ) : (
          <span className="text-even-ink-500">not named {turn.voice.no_role_reason ? `(${turn.voice.no_role_reason})` : ""}</span>
        )}
      </p>

      {turn.time_basis === "window_start" ? (
        <p className="text-[10px] mt-1 uppercase tracking-wide text-red-600">
          time estimated - no cue or source_ref timing joined; the window's own bounds are shown instead
        </p>
      ) : null}

      {/* Emotion - visible per V's ruling, always carrying its markers. */}
      <p className="text-[11px] mt-1 text-even-ink-500">
        {!surfaceEnabled ? (
          <span>emotion surface off</span>
        ) : turn.emotion ? (
          <span>
            {turn.emotion.top_label} {fmtPct(turn.emotion.top_score)} over {turn.emotion.speech_ms ?? "?"} ms of speech
            {" "}
            <span className="uppercase text-[9px] tracking-wide">(UNCALIBRATED - no floor set from data)</span>
          </span>
        ) : (
          <span>not scored</span>
        )}
      </p>
    </div>
  );
}

function SlotCard({ slot, surfaceEnabled }: { slot: TapeSlot; surfaceEnabled: boolean }) {
  if (slot.kind === "no_recording") {
    return (
      <div className="flex items-center gap-3 px-4 py-2 border-t border-even-ink-100 text-caption text-even-ink-500">
        <span className="w-32 shrink-0">{slot.label}</span>
        <span className="italic">no recording - we were not recording this room in this slot</span>
      </div>
    );
  }

  const w = slot.window;
  return (
    <div className="border-t border-even-ink-100 px-4 py-3">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="w-32 shrink-0 text-caption text-even-navy-800">{slot.label}</span>
        <span className={`text-[11px] px-2 py-0.5 rounded-full border ${STATE_STYLE[w.state]}`} title={STATE_HINT[w.state]}>
          {w.state}
        </span>
        <span className="text-[11px] text-even-ink-500">{w.source_mic} mic</span>
        {w.state === "closed" ? (
          <span className={`text-[11px] ${w.drain_reachable ? "text-even-ink-500" : "text-red-600"}`}>
            {w.drain_reachable ? "reachable by the next auto-drain" : "past the auto-drain age limit - needs a deliberate backfill"}
          </span>
        ) : null}
        {w.auto_drain_refused_reason ? (
          <span className="text-[11px] text-red-600">last drain refused: {w.auto_drain_refused_reason}</span>
        ) : null}
      </div>

      {w.transcript ? (
        <div className="mt-2 text-caption">
          <p className="text-even-navy-800 whitespace-pre-wrap">{w.transcript.text ?? <span className="italic text-even-ink-500">(no transcript text)</span>}</p>
          <p className="text-[11px] text-even-ink-500 mt-1">
            engine {w.transcript.engine ?? "-"} - language {w.transcript.language ?? "-"} - activity {w.transcript.activity ?? "-"}
            {w.transcript.error ? <span className="text-red-600"> - error: {w.transcript.error}</span> : null}
          </p>
        </div>
      ) : null}

      {w.diarize ? (
        <p className="text-[11px] text-even-ink-500 mt-1">
          diarize: {w.diarize.state}
          {w.diarize.speaker_count !== null ? ` - ${w.diarize.speaker_count} speaker(s)` : ""}
          {w.diarize.error ? ` - error: ${w.diarize.error}` : ""}
        </p>
      ) : null}

      {w.emotion_window ? (
        <p className="text-[11px] text-even-ink-500 mt-1">
          emotion job: {w.emotion_window.state}
          {w.emotion_window.segments_scored !== null ? ` - ${w.emotion_window.segments_scored} scored` : ""}
          {w.emotion_window.error ? ` - error: ${w.emotion_window.error}` : ""}
        </p>
      ) : null}

      {w.turns.length > 0 ? (
        <div className="mt-2 pl-1">
          {w.turns.map((t) => (
            <TurnRow key={t.source_ref} turn={t} surfaceEnabled={surfaceEnabled} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function RoomDayTapeClient({ roomId, istDate }: { roomId: string; istDate: string }) {
  const [data, setData] = React.useState<FetchResp | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/rooms/${roomId}/days/${istDate}`, { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) {
        const msg = (j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`;
        throw new Error(msg);
      }
      setData(j as FetchResp);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [roomId, istDate]);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) return <p className="text-caption text-even-ink-500 p-4">Loading...</p>;
  if (error) return <p className="text-caption text-red-600 p-4">Could not load this room-day: {error}</p>;
  if (!data) return null;

  const { tape } = data;
  const surfaceEnabled = tape.emotion.surface_enabled;

  return (
    <div className="space-y-4">
      <div className="bg-even-white rounded-xl border border-even-ink-200 p-4">
        <p className="text-heading text-even-navy-800">{tape.room.name} - {tape.room_day.ist_date}</p>
        <p className="text-caption text-even-ink-500 mt-1">
          {tape.totals.slots} slots - {tape.totals.windows} windows - {tape.totals.turns} turns named {tape.totals.turns_named}, with a losing score {tape.totals.turns_with_losing_score}
        </p>
        <p className="text-caption text-even-ink-500 mt-1">
          by state: {Object.entries(tape.totals.by_state).map(([s, n]) => `${s} ${n}`).join(" - ") || "-"}
        </p>
        <p className="text-[11px] text-even-ink-500 mt-2">
          emotion compute {tape.emotion.compute_enabled ? "on" : "off"} - surface {tape.emotion.surface_enabled ? "on" : "off"}
        </p>
        <p className="text-[10px] uppercase tracking-wide text-even-ink-500 mt-2">
          voice cosine thresholds (UNRATIFIED): room 0.65 - encounter 0.70 - phone 0.78 - labels on this page, never settled facts
        </p>
      </div>

      <div className="bg-even-white rounded-xl border border-even-ink-200 overflow-hidden">
        {tape.slots.map((slot) => (
          <SlotCard key={slot.start_ms} slot={slot} surfaceEnabled={surfaceEnabled} />
        ))}
      </div>
    </div>
  );
}
