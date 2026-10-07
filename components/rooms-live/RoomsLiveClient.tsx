"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEGRADED_NOTE, GROUND, counts, groupOf, type Group } from "@/lib/rooms-live/present";
import type { RoomRow, Snapshot } from "@/lib/rooms-live/snapshot";
import { chipAlarm, durationOf, sortAttention, type EscalationLevel } from "@/lib/rooms-live/escalation";
import { RoomDetail } from "./RoomDetail";
import { RoomTile } from "./RoomTile";

export const POLL_MS = 15_000;
const ENG_KEY = "rooms-live-eng";
export const NAME_KEY = "roomsLive.name";
const NAME_MAX = 64;

/** a typed display name: control characters out, runs of spaces collapsed, 1-64 chars; "" when it does not qualify */
const tidyName = (raw: string): string => {
  const n = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return n.length >= 1 && n.length <= NAME_MAX ? n : "";
};

const GROUPS: Array<{ g: Group; title: string; note?: string }> = [
  { g: "attention", title: "Needs attention" },
  { g: "fine", title: "Fine" },
  { g: "nodoctor", title: "No doctor signed in", note: "Rooms with nobody signed in. A problem here is not urgent." },
];

export default function RoomsLiveClient({ who }: { who: { kind: "admin" | "staff" | "open"; name: string } }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [eng, setEng] = useState(false);
  // open access (8 Oct 2026): nobody logs in, so an "I'm on it" carries the name this browser remembered (localStorage; the page works when storage throws)
  const [name, setName] = useState("");
  const [askFor, setAskFor] = useState<string | null>(null); // the room whose "I'm on it" is waiting for a name
  const [draft, setDraft] = useState("");
  const fetchedAt = useRef<number>(0);
  // when THIS browser first saw a room in its current state: the duration fallback when the server has no state_since (resets on reload)
  const firstSeen = useRef<Map<string, { state: string; at: number }>>(new Map());

  useEffect(() => {
    try {
      setEng(window.localStorage.getItem(ENG_KEY) === "1");
    } catch {
      /* storage unavailable: the toggle simply starts off */
    }
    try {
      setName(tidyName(window.localStorage.getItem(NAME_KEY) ?? ""));
    } catch {
      /* storage unavailable: the name is asked for each time */
    }
  }, []);
  const toggleEng = () =>
    setEng((v) => {
      const n = !v;
      try {
        window.localStorage.setItem(ENG_KEY, n ? "1" : "0");
      } catch {
        /* ignore */
      }
      return n;
    });

  const logout = async () => {
    try {
      await fetch("/api/rooms-live/logout", { method: "POST" });
    } finally {
      window.location.reload();
    }
  };
  const needsName = who.kind === "open" && !name;
  const act = async (roomId: string, action: "claim" | "clear", nameOverride?: string) => {
    setNotice(null);
    const sendName = nameOverride ?? name;
    try {
      const res = await fetch("/api/rooms-live/claims", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sendName ? { room_id: roomId, action, name: sendName } : { room_id: roomId, action }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; existing?: { claimed_by?: string } };
      if (res.status === 409 && j.reason === "already_claimed") setNotice(`${j.existing?.claimed_by ?? "Someone"} is on it`);
      else if (!res.ok && res.status !== 404) setNotice("Could not save that just now. Try again.");
    } catch {
      setNotice("Can't reach the server. Try again.");
    }
    void load();
  };
  const onClaim = (roomId: string) => {
    if (needsName) {
      setAskFor(roomId);
      return;
    }
    void act(roomId, "claim");
  };
  const submitName = () => {
    const n = tidyName(draft);
    if (!n || !askFor) return;
    setName(n);
    try {
      window.localStorage.setItem(NAME_KEY, n);
    } catch {
      /* storage unavailable: the name is asked for again next visit */
    }
    const roomId = askFor;
    setAskFor(null);
    void act(roomId, "claim", n);
  };

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/rooms-live/now", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const next = (await res.json()) as Snapshot;
      const t = Date.now();
      for (const r of next.rooms) {
        const seen = firstSeen.current.get(r.room_id);
        if (!seen || seen.state !== r.state) firstSeen.current.set(r.room_id, { state: r.state, at: t });
      }
      setSnap(next);
      fetchedAt.current = Date.now();
      setErr(false);
    } catch {
      setErr(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = window.setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_MS);
    const onVis = () => {
      if (!document.hidden && Date.now() - fetchedAt.current > POLL_MS) void load();
    };
    document.addEventListener("visibilitychange", onVis);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  const rows: RoomRow[] = snap?.rooms ?? [];
  const c = useMemo(() => counts(rows), [rows]);
  const age = snap ? Math.max(0, Math.round((now - Date.parse(snap.generated_at)) / 1000)) : null;
  const attention = useMemo(
    () =>
      sortAttention(
        rows.filter((r) => groupOf(r) === "attention").map((r) => ({ item: r, ms: durationOf(r, now, firstSeen.current.get(r.room_id)?.at ?? null) })),
      ),
    [rows, now],
  );
  const alarm = chipAlarm(attention.map((a) => a.level));
  const openRow = rows.find((r) => r.room_id === open) ?? null;
  const stamp = new Date(now).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <main style={{ background: GROUND, minHeight: "100vh", padding: "16px 16px 48px", fontFamily: '"Atkinson Hyperlegible Next", "Atkinson Hyperlegible", system-ui, -apple-system, "Segoe UI", sans-serif', color: "#22262B", maxWidth: 1100, margin: "0 auto" }}>
      <style>{`
        @keyframes rl-pulse { 0%, 100% { outline: 3px solid rgba(122,20,16,0); outline-offset: 2px; } 50% { outline: 3px solid rgba(122,20,16,.85); outline-offset: 4px; } }
        .rl-pulse { animation: rl-pulse 2s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .rl-pulse { animation: none; box-shadow: inset 0 0 0 4px #FFFFFF; } }
      `}</style>
      <header style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 28 }}>Rooms</h1>
          <div style={{ fontSize: 14, color: "#4F535A" }}>{stamp}{who.kind === "open" ? (name ? ` · ${name}` : "") : ` · ${who.name}`}{who.kind === "staff" ? <> · <button type="button" onClick={() => void logout()} style={{ background: "none", border: "none", color: "#1D4F8C", textDecoration: "underline", fontSize: 14, cursor: "pointer", minHeight: 44, padding: 0 }}>Log out</button></> : null}</div>
        </div>
        <div style={{ display: "flex", gap: 14, fontSize: 15, flexWrap: "wrap", alignItems: "center" }} aria-live="polite">
          <span style={alarm ? { background: "#7A1410", color: "#FFFFFF", borderRadius: 999, padding: "6px 12px" } : undefined}><b style={alarm ? undefined : { color: "#9E2A1E" }}>{c.need}</b> need you</span>
          <span><b style={{ color: "#1D6B57" }}>{c.fine}</b> fine</span>
          <span><b>{c.nodoctor}</b> no doctor</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: err ? "#9E2A1E" : "#4F535A" }}>
            <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: 9, background: err ? "#9E2A1E" : "#1D6B57", display: "inline-block" }} />
            {err ? "Can't reach the server" : age === null ? "Loading…" : `updated ${age} s ago`}
          </span>
        </div>
      </header>
      {snap && snap.degraded.length > 0 ? <p role="status" style={{ background: "#FBE9D6", color: "#8A3F05", borderRadius: 10, padding: "8px 12px", fontSize: 14 }}>{DEGRADED_NOTE}</p> : null}
      {notice ? <p role="status" style={{ background: "#ECEBE6", borderRadius: 10, padding: "10px 12px", fontSize: 15, fontWeight: 700 }}>{notice}</p> : null}
      {askFor ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitName();
          }}
          style={{ background: "#FFFFFF", border: "1px solid #C9CBCF", borderRadius: 10, padding: "10px 12px", marginBottom: 12, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}
        >
          <label style={{ fontSize: 15, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 8 }}>
            Your name
            <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={NAME_MAX} required autoFocus autoComplete="name" style={{ minHeight: 44, borderRadius: 10, border: "1px solid #C9CBCF", padding: "0 10px", fontSize: 16, width: 220, maxWidth: "100%" }} />
          </label>
          <button type="submit" disabled={!tidyName(draft)} style={{ minHeight: 44, padding: "0 16px", borderRadius: 10, border: "2px solid #22262B", background: "#22262B", color: "#FFFFFF", fontSize: 15, fontWeight: 800, cursor: "pointer" }}>I’m on it</button>
          <button type="button" onClick={() => setAskFor(null)} style={{ minHeight: 44, padding: "0 14px", borderRadius: 10, border: "1px solid #C9CBCF", background: "transparent", color: "#22262B", fontSize: 14, cursor: "pointer" }}>Cancel</button>
        </form>
      ) : null}
      {GROUPS.map(({ g, title, note }) => {
        const list: Array<{ row: RoomRow; level?: EscalationLevel; ms?: number }> =
          g === "attention" ? attention.map((a) => ({ row: a.item, level: a.level, ms: a.ms })) : rows.filter((r) => groupOf(r) === g).map((row) => ({ row }));
        if (list.length === 0) return null;
        return (
          <section key={g} aria-label={title} style={{ marginBottom: 18 }}>
            <h2 style={{ fontSize: 17, margin: "0 0 4px" }}>{title} <span style={{ color: "#4F535A", fontWeight: 400 }}>({list.length})</span></h2>
            {note ? <p style={{ margin: "0 0 8px", fontSize: 13, color: "#4F535A" }}>{note}</p> : null}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(290px, 1fr))", gap: 12, opacity: g === "nodoctor" ? 0.92 : 1 }}>
              {list.map(({ row, level, ms }) => (
                <RoomTile key={row.room_id} row={row} nowMs={now} eng={eng} calm={g === "nodoctor"} level={level} durMs={ms} canClaim={g === "attention"} onClaim={() => onClaim(row.room_id)} onClear={() => void act(row.room_id, "clear")} onOpen={() => setOpen(row.room_id)} />
              ))}
            </div>
          </section>
        );
      })}
      <footer style={{ marginTop: 24, fontSize: 13, color: "#4F535A" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, minHeight: 44 }}>
          <input type="checkbox" checked={eng} onChange={toggleEng} style={{ width: 20, height: 20 }} /> Engineering details
        </label>
      </footer>
      {openRow ? <RoomDetail row={openRow} nowMs={now} onClose={() => setOpen(null)} /> : null}
    </main>
  );
}
