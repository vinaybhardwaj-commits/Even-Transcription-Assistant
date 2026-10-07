"use client";
import { useEffect, useState } from "react";
import { COLORS, DAY_LEGEND, WORD, headline, segmentColor, segmentWord, stepsFor } from "@/lib/rooms-live/present";
import type { RoomRow } from "@/lib/rooms-live/snapshot";

type Day = { as_of: string | null; segments: Array<{ state: string; start: string; end: string }> };
const IST_MS = 19_800_000;
const dayStartMs = (now: number) => Math.floor((now + IST_MS) / 86_400_000) * 86_400_000 - IST_MS;

export function RoomDetail({ row, nowMs, onClose }: { row: RoomRow; nowMs: number; onClose: () => void }) {
  const [day, setDay] = useState<Day | null | "none">(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/rooms-live/day?room_id=${encodeURIComponent(row.room_id)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: Day | null) => {
        if (live) setDay(j && Array.isArray(j.segments) && j.segments.length > 0 ? j : "none");
      })
      .catch(() => live && setDay("none"));
    return () => {
      live = false;
    };
  }, [row.room_id]);
  const c = COLORS[row.state];
  const steps = stepsFor(row.state);
  const start = dayStartMs(nowMs);
  return (
    <div role="dialog" aria-modal="true" aria-label={`${row.label} details`} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 50 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#F6F5F2", width: "100%", maxWidth: 560, maxHeight: "90vh", overflowY: "auto", borderRadius: "18px 18px 0 0", padding: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>{row.label}</h2>
          <button type="button" onClick={onClose} aria-label="Close" style={{ minWidth: 44, minHeight: 44, borderRadius: 10, border: "1px solid #E4E2DC", background: "#fff", fontSize: 18 }}>×</button>
        </div>
        <div style={{ margin: "8px 0", background: c.bg, color: c.fg, borderRadius: 10, padding: "8px 12px", fontWeight: 700 }}>{WORD[row.state]}: {headline(row)}</div>
        {steps.length > 0 ? (
          <ol style={{ paddingLeft: 22, fontSize: 16, lineHeight: 1.45 }}>
            {steps.map((s) => (
              <li key={s} style={{ marginBottom: 6 }}>{s}</li>
            ))}
          </ol>
        ) : (
          <p style={{ fontSize: 16 }}>Nothing to do. {headline(row)}.</p>
        )}
        <h3 style={{ fontSize: 15, margin: "14px 0 6px" }}>Today</h3>
        {day === "none" ? (
          <p style={{ fontSize: 14, color: "#4F535A", margin: 0 }}>Day history not available yet</p>
        ) : day === null ? (
          <p style={{ fontSize: 14, color: "#4F535A", margin: 0 }}>Loading…</p>
        ) : (
          <>
            <div role="img" aria-label="Today, colour strip by hour" style={{ position: "relative", height: 22, borderRadius: 6, background: "#ECEBE6", overflow: "hidden" }}>
              {day.segments.map((s, i) => {
                const l = Math.max(0, (Date.parse(s.start) - start) / 86_400_000) * 100;
                const w = Math.max(0.2, ((Date.parse(s.end) - Date.parse(s.start)) / 86_400_000) * 100);
                return <div key={i} title={segmentWord(s.state)} style={{ position: "absolute", left: `${l}%`, width: `${w}%`, top: 0, bottom: 0, background: segmentColor(s.state) }} />;
              })}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#4F535A" }}><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
            <ul aria-label="Colour key" style={{ listStyle: "none", display: "flex", flexWrap: "wrap", gap: "4px 14px", padding: 0, margin: "6px 0 0", fontSize: 12, color: "#4F535A" }}>
              {DAY_LEGEND.map((l) => (
                <li key={l.word} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span aria-hidden="true" style={{ width: 12, height: 12, borderRadius: 3, background: l.color, display: "inline-block" }} />{l.word}</li>
              ))}
            </ul>
            {day.as_of ? <p style={{ fontSize: 12, color: "#4F535A", margin: "4px 0 0" }}>as of {new Date(day.as_of).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}</p> : null}
          </>
        )}
      </div>
    </div>
  );
}
