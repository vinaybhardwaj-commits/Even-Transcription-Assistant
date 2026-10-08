"use client";
import type { CSSProperties } from "react";
import { COLORS, ICON, NO_DOCTOR_PROBLEM_NOTE, WORD, showNoDoctorNote, BAR_TICK_FRACTION, barFraction, forMinutes, headline, isProblem, stepsFor } from "@/lib/rooms-live/present";
import { cardStyle, L4_FILL as L4_TEXT, type EscalationLevel } from "@/lib/rooms-live/escalation";
import type { RoomRow } from "@/lib/rooms-live/snapshot";

const box: CSSProperties = { background: "#fff", borderRadius: 14, padding: 14, border: "1px solid #E4E2DC", display: "flex", flexDirection: "column", gap: 8 };

export function SoundBar({ row, onDark }: { row: RoomRow; onDark?: boolean }) {
  const c = COLORS[row.state];
  const pct = Math.round(barFraction(row.level.rms, row.baseline_rms) * 100);
  const grey = row.level.stale || row.state === "off" || row.state === "unplugged" || row.state === "notrec" || row.state === "unknown";
  return (
    <div role="meter" aria-label="Sound level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={grey ? 0 : pct} style={{ height: 8, borderRadius: 4, background: onDark ? "rgba(255,255,255,.28)" : "#ECEBE6", overflow: "hidden", position: "relative" }}>
      <div style={{ width: `${grey ? 0 : pct}%`, height: "100%", background: onDark ? "#FFFFFF" : c.fg, transition: "width .6s ease" }} />
      <div aria-hidden="true" data-testid="speech-tick" style={{ position: "absolute", left: `${BAR_TICK_FRACTION * 100}%`, top: 0, bottom: 0, width: 2, background: onDark ? "rgba(255,255,255,.75)" : "#4F535A" }} />
    </div>
  );
}

export function RoomTile({ row, nowMs, eng, calm, level, durMs, canClaim, onClaim, onClear, onOpen }: { row: RoomRow; nowMs: number; eng: boolean; calm?: boolean; level?: EscalationLevel; durMs?: number; canClaim?: boolean; onClaim?: () => void; onClear?: () => void; onOpen: () => void }) {
  // a room with no doctor signed in stays calm grey even when it has a problem (the note says to check before the next doctor)
  const c = calm ? COLORS.quiet : COLORS[row.state];
  const problem = isProblem(row.state);
  const esc = !calm && problem && level !== undefined;
  const st = esc ? cardStyle(level!, row.state) : null;
  const fg = st ? st.fg : "#22262B";
  const since = esc && durMs !== undefined && durMs >= 0 ? forMinutes(new Date(nowMs - durMs).toISOString(), nowMs) : forMinutes(row.state_since, nowMs);
  const first = stepsFor(row.state)[0];
  const cardStyleObj: CSSProperties = st
    ? { ...box, background: st.bg, color: fg, border: `${st.borderWidth}px solid ${st.border}` }
    : { ...box, color: fg };
  const pill: CSSProperties = st
    ? { background: st.pill.bg, color: st.pill.fg, border: `1.5px solid ${st.pill.border}`, borderRadius: 999, padding: "6px 12px", fontSize: 14, fontWeight: 700, whiteSpace: "nowrap" }
    : { background: c.bg, color: c.fg, borderRadius: 999, padding: "6px 12px", fontSize: 14, fontWeight: 700, whiteSpace: "nowrap" };
  const dark = !!st && (level === 3 || level === 4);
  const sub = st && (level === 3 || level === 4) ? "rgba(255,255,255,.92)" : "#4F535A";
  return (
    <section aria-label={`${row.label}: ${WORD[row.state]}`} className={st && level === 4 ? "rl-pulse" : undefined} data-level={esc ? level : undefined} style={cardStyleObj}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{row.label}</div>
          <div style={{ fontSize: 14, color: sub }}>{row.doctor ? `${row.doctor.display} · ${row.doctor.activity}` : row.doctor_known === false ? "Doctor not known right now" : "No doctor signed in"}</div>
        </div>
        <span style={pill}>
          <span aria-hidden="true">{ICON[row.state]} </span>
          {WORD[row.state]}
        </span>
      </div>
      <SoundBar row={row} onDark={!!st && (level === 3 || level === 4)} />
      <div style={{ fontSize: 16, fontWeight: 600, color: st ? fg : c.fg }}>{headline(row)}</div>
      {(problem || row.state === "unknown") && first ? <div style={{ fontSize: 15 }}>{first}</div> : null}
      {showNoDoctorNote(row) ? <div style={{ fontSize: 14, color: sub }}>{NO_DOCTOR_PROBLEM_NOTE}</div> : null}
      {since && (esc || row.state_since !== null) ? <div style={{ fontSize: 13, color: sub, fontWeight: st?.boldFor ? 800 : 400 }}>{since}</div> : null}
      {eng ? (
        <pre style={{ fontSize: 11, background: "#F6F5F2", color: "#22262B", padding: 8, borderRadius: 8, overflowX: "auto", margin: 0 }}>
          {JSON.stringify({ detail: row.detail_code, level, rms: row.level.rms, zero: row.level.zero, baseline: row.baseline_rms, stale: row.level.stale, ages_s: row.ages_s, session: row.session.open, device: row.device, steward: row.steward }, null, 1)}
        </pre>
      ) : null}
      {problem || row.state === "unknown" ? (
        <button type="button" onClick={onOpen} style={{ minHeight: 44, borderRadius: 10, border: `1px solid ${st ? (level === 3 || level === 4 ? "#FFFFFF" : c.fg) : c.fg}`, background: st && (level === 3 || level === 4) ? "transparent" : "#fff", color: st && (level === 3 || level === 4) ? "#FFFFFF" : c.fg, fontSize: 15, fontWeight: 700, cursor: "pointer" }}>
          How to fix
        </button>
      ) : (
        <button type="button" onClick={onOpen} style={{ minHeight: 44, borderRadius: 10, border: "1px solid #E4E2DC", background: "#fff", color: "#4F535A", fontSize: 14, cursor: "pointer" }}>
          Details
        </button>
      )}
      {canClaim && problem ? (
        row.claim ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 15, fontWeight: 700 }}>
            <span>{`${row.claim.by} is on it · ${claimMinutes(row.claim.since, nowMs)}`}</span>
            <button type="button" onClick={onClear} style={{ minHeight: 44, padding: "0 14px", borderRadius: 10, border: `1px solid ${dark ? "#FFFFFF" : "#C9CBCF"}`, background: "transparent", color: dark ? "#FFFFFF" : "#22262B", fontSize: 14, cursor: "pointer" }}>Clear</button>
          </div>
        ) : (
          <button type="button" onClick={onClaim} style={{ minHeight: 48, borderRadius: 10, border: `2px solid ${dark ? "#FFFFFF" : "#22262B"}`, background: dark ? "#FFFFFF" : "#22262B", color: dark ? L4_TEXT : "#FFFFFF", fontSize: 16, fontWeight: 800, cursor: "pointer" }}>
            I’m on it
          </button>
        )
      ) : null}
    </section>
  );
}

function claimMinutes(since: string, nowMs: number): string {
  const m = Math.max(0, Math.floor((nowMs - Date.parse(since)) / 60_000));
  return m < 1 ? "under 1 min" : `${m} min`;
}
