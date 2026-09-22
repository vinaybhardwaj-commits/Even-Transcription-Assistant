"use client";

/**
 * BenchClient — admin Bench page body (Room-Bench PRD §3.5; mockup
 * screens 4 & 6): sessions table with rollups + live badge (last verified
 * chunk < 7 min old), and the Rooms card (create → slug + PIN shown once;
 * reset PIN; disable/enable). Rooms never appear on the Clinicians page.
 */

import * as React from "react";
import { isBenchStalled } from "@/lib/bench-reaper-core";
import Link from "next/link";
import { selectedRoom, useSelectedRoom } from "@/components/admin/BenchRoomsLive";

/**
 * A3 — one class for the in-table actions. min-h-11 is 44px; the horizontal padding takes the
 * width past 44 for every label used here. The text does NOT shrink to pay for the padding.
 */
const ROW_BTN =
  "min-h-11 px-3 py-2 rounded-lg text-label text-even-blue-700 hover:bg-even-ink-50 active:bg-even-ink-100";

type SessionRow = {
  id: string;
  label: string | null;
  started_at: string;
  ended_at: string | null;
  status: string;
  room_name: string;
  room_slug: string;
  chunk_count: number;
  verified_count: number;
  total_bytes: number;
  gap_ms: number;
  gap_count: number;
  last_chunk_at: string | null;
  /** K-A: newest chunk across both sources — the `stalled` chip's clock */
  last_any_chunk_at?: string | null;
  /** K-B (R10): backup stream + mic badge */
  backup_chunk_count?: number;
  backup_verified_count?: number;
  primary_lost_count?: number;
  primary_restored_count?: number;
  mic_status?: "on_backup" | "backup_covered" | "lost_no_backup" | null;
};

type RoomRow = {
  id: string;
  slug: string;
  name: string;
  disabled: boolean;
  last_session_at: string | null;
  last_session_status: string | null;
};

function fmtMb(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function fmtDuration(startIso: string, endIso: string | null): string {
  const ms = (endIso ? new Date(endIso).getTime() : Date.now()) - new Date(startIso).getTime();
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function fmtGap(ms: number, count: number): string {
  if (count === 0 || ms < 2000) return "—";
  const m = Math.round(ms / 60_000);
  return `${count} gap${count === 1 ? "" : "s"} · ${m < 1 ? "<1" : m}m`;
}

function isLive(s: SessionRow): boolean {
  if (s.status !== "recording" || !s.last_chunk_at) return false;
  return Date.now() - new Date(s.last_chunk_at).getTime() < 7 * 60_000;
}

/** K-A (R10, the time-based case): a 'recording' session whose newest chunk across BOTH sources is
 *  > 10 min old reads `stalled` (red). K-B's mic badges render first and take visual precedence. */
function isStalled(s: SessionRow): boolean {
  return isBenchStalled({ status: s.status, last_any_chunk_at: s.last_any_chunk_at ?? s.last_chunk_at, started_at: s.started_at }, Date.now());
}

export function BenchClient() {
  const [sessions, setSessions] = React.useState<SessionRow[] | null>(null);
  const [rooms, setRooms] = React.useState<RoomRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [newRoomName, setNewRoomName] = React.useState("");
  const [showCreate, setShowCreate] = React.useState(false);
  const [createdRoom, setCreatedRoom] = React.useState<{
    name: string;
    slug: string;
    pin: string;
  } | null>(null);
  const [resetPin, setResetPin] = React.useState<{ name: string; pin: string } | null>(null);
  /** Which room's card is open for rename, and the draft in its box. */
  const [renaming, setRenaming] = React.useState<{ id: string; draft: string } | null>(null);
  const [renameError, setRenameError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const [sRes, rRes] = await Promise.all([
        fetch("/api/bench/sessions"),
        fetch("/api/bench/rooms"),
      ]);
      if (sRes.ok) setSessions(((await sRes.json()) as { sessions: SessionRow[] }).sessions);
      else setSessions([]);
      if (rRes.ok) setRooms(((await rRes.json()) as { rooms: RoomRow[] }).rooms);
      else setRooms([]);
    } catch {
      setSessions((s) => s ?? []);
      setRooms((r) => r ?? []);
      setError("Could not load bench data.");
    }
  }, []);

  React.useEffect(() => {
    void load();
    // B1 — skip the poll while the tab is hidden, matching BenchRoomsLive's two polls. A tablet
    // in a pocket was refetching the whole session and room list every minute, all day.
    const t = setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const onCreateRoom = React.useCallback(async () => {
    const name = newRoomName.trim();
    if (name.length < 2) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/bench/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error?.message ?? "create_failed");
      setCreatedRoom({ name: j.room.name, slug: j.room.slug, pin: j.pin_plaintext });
      setNewRoomName("");
      setShowCreate(false);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [newRoomName, load]);

  const onResetPin = React.useCallback(
    async (room: RoomRow) => {
      try {
        const res = await fetch("/api/bench/rooms", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room_id: room.id, action: "reset_pin" }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error?.message ?? "reset_failed");
        setResetPin({ name: room.name, pin: j.pin_plaintext });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

  const onToggleDisabled = React.useCallback(
    async (room: RoomRow) => {
      try {
        await fetch("/api/bench/rooms", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room_id: room.id, action: room.disabled ? "enable" : "disable" }),
        });
        void load();
      } catch {
        setError("Room update failed.");
      }
    },
    [load],
  );

  const onRename = React.useCallback(
    async (roomId: string, raw: string) => {
      const name = raw.trim();
      setRenameError(null);
      if (name.length < 2) { setRenameError("room_name_required"); return; }
      if (name.length > 64) { setRenameError("room_name_too_long"); return; }
      try {
        const res = await fetch("/api/bench/rooms", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room_id: roomId, action: "rename", name }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error?.message ?? "rename_failed");
        setRenaming(null);
        void load();
      } catch (e) {
        // Named, not swallowed: room_name_already_exists is the one an operator will hit, and
        // "rename failed" would leave them guessing which of two rooms already has the name.
        setRenameError(e instanceof Error ? e.message : String(e));
      }
    },
    [load],
  );

  // ---- Recordings BY ROOM (E4) ----------------------------------------------------------
  // The flat all-rooms table is gone. Sessions are shown for ONE room, chosen on the monitor's
  // cards above, and the selection survives every poll because it lives outside this component.
  const selectedId = useSelectedRoom()?.roomId ?? null;
  const roomById = React.useMemo(() => new Map((rooms ?? []).map((r) => [r.id, r])), [rooms]);
  const deepLinkApplied = React.useRef(false);

  React.useEffect(() => {
    if (deepLinkApplied.current || !rooms?.length) return;
    deepLinkApplied.current = true;
    const wanted = new URL(window.location.href).searchParams.get("room");
    if (!wanted) return;
    const room = rooms.find((candidate) => candidate.id === wanted || candidate.slug === wanted);
    if (room) selectedRoom.choose(room.id);
  }, [rooms]);

  // DEFAULT, second and third rules: the room with the most recent session, else the first room.
  // (The first rule — the room that is RECORDING — is suggested by the monitor, which is the
  // component that knows. `suggest` never overrides a click, so neither can fight the operator.)
  React.useEffect(() => {
    if (selectedId || !rooms || rooms.length === 0 || sessions === null) return;
    let bestRoom: string | null = null;
    let bestAt = -Infinity;
    for (const sess of sessions) {
      const room = (rooms ?? []).find((r) => r.slug === sess.room_slug);
      if (!room) continue;
      const t = new Date(sess.started_at).getTime();
      if (Number.isFinite(t) && t > bestAt) { bestAt = t; bestRoom = room.id; }
    }
    selectedRoom.suggest(bestRoom ?? rooms[0]!.id);
  }, [selectedId, rooms, sessions]);

  const selectedRoomRow = selectedId ? roomById.get(selectedId) ?? null : null;
  const roomSessions = React.useMemo(
    () => (selectedRoomRow && sessions ? sessions.filter((x) => x.room_slug === selectedRoomRow.slug) : []),
    [sessions, selectedRoomRow],
  );

  return (
    <div className="space-y-6">
      {error && (
        <p className="text-caption text-danger-700" role="alert">
          {error}
        </p>
      )}

      {/* ===== Recordings, for the SELECTED room (E4) =====
          PART C — an 8-column table is not readable while walking an OPD, and it is not
          deletable either: it is the day's history and the desk needs it. So below `lg` it is
          folded behind a tapped summary and starts closed; at `lg` it is open and nothing has
          moved. <details> does the work — no state, no JS, and it stays open once the operator
          opens it. */}
      <Disclosure summary={selectedRoomRow ? `${selectedRoomRow.name} recordings` : "Recordings"} count={selectedRoomRow ? `${roomSessions.length} session${roomSessions.length === 1 ? "" : "s"}` : null}>
      <section className="eta-card p-5 overflow-x-auto">
        <div className="flex items-baseline justify-between gap-3 mb-3">
          <h2 className="text-heading text-even-navy-800">
            {selectedRoomRow ? `${selectedRoomRow.name} recordings` : "Recordings"}
            <span className="ml-2 text-caption font-normal text-even-ink-400">
              {selectedRoomRow ? `· ${roomSessions.length} session${roomSessions.length === 1 ? "" : "s"}` : null}
            </span>
          </h2>
          {rooms && rooms.length > 1 ? (
            <p className="text-caption text-even-ink-400">select a room card above to switch</p>
          ) : null}
        </div>
        <table className="w-full text-body">
          <thead>
            <tr className="text-left border-b border-even-ink-100">
              {/* No Room column: every row is the same room now, and repeating it is noise. */}
              {["Session", "Date", "Duration", "Chunks", "Verified", "Gaps", "Size", "Status"].map(
                (h) => (
                  <th
                    key={h}
                    className="py-2 px-2.5 text-meta uppercase tracking-wider text-even-ink-400 font-semibold"
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {sessions === null ? (
              <tr>
                <td colSpan={8} className="py-6 px-2.5 text-caption text-even-ink-400">
                  Loading…
                </td>
              </tr>
            ) : roomSessions.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-6 px-2.5 text-caption text-even-ink-400">
                  {selectedRoomRow
                    ? `No recordings yet for ${selectedRoomRow.name}. Sign in at /room/${selectedRoomRow.slug} on the Mini and start a recording day.`
                    : "No bench sessions yet. Create a room below, sign in at its /room URL and start a recording day."}
                </td>
              </tr>
            ) : (
              roomSessions.map((s) => (
                <tr key={s.id} className="border-b border-even-ink-50 hover:bg-even-ink-50">
                  <td className="py-2.5 px-2.5">
                    <Link href={`/admin/bench/${s.id}`} className="text-even-blue-700 hover:underline">
                      {s.label ?? s.id}
                    </Link>
                  </td>
                  <td className="py-2.5 px-2.5 whitespace-nowrap">
                    {new Date(s.started_at).toLocaleDateString("en-GB", {
                      day: "numeric",
                      month: "short",
                    })}
                  </td>
                  <td className="py-2.5 px-2.5 tabular-nums whitespace-nowrap">
                    {fmtDuration(s.started_at, s.ended_at)}
                  </td>
                  <td className="py-2.5 px-2.5 tabular-nums">{s.chunk_count}</td>
                  <td className="py-2.5 px-2.5 tabular-nums whitespace-nowrap">
                    {s.verified_count} / {s.chunk_count}
                  </td>
                  <td className="py-2.5 px-2.5 whitespace-nowrap">
                    {s.gap_count > 0 ? (
                      <span className="inline-block px-2 py-0.5 rounded-full text-caption font-semibold bg-warning-100 text-warning-700">
                        {fmtGap(s.gap_ms, s.gap_count)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-2.5 px-2.5 tabular-nums whitespace-nowrap">
                    {fmtMb(s.total_bytes)}
                  </td>
                  <td className="py-2.5 px-2.5 whitespace-nowrap">
                    {/* THE MIC BADGE IS GONE, and rendering nothing is the point (Build 1 §3.4).
                        It read the stale lost-microphone flag: `primary_lost_count > 0` on a
                        session, which does not clear and does not mean the session ran on the
                        spare. So a session that used its MAIN microphone from the first piece to
                        the last was labelled "on backup mic · 40 chunks" in amber, and the two
                        siblings of that branch — "mic lost N× · no backup" in red, and
                        "backup used N× · mic restored" — read the same flag and make the same
                        claim. Two working microphones raised this alarm twice in one morning.

                        NOT REPLACED WITH A SIZE JUDGEMENT: deciding which microphone actually
                        carried a session from the bytes is Build 2, and guessing it here would
                        put a second false badge where the first one was. Render nothing rather
                        than something false. `mic_status` is still on the wire and nothing
                        reads it. */}
                    {isStalled(s) ? (
                      <span
                        className="inline-block px-2 py-0.5 rounded-full text-caption font-semibold bg-danger-100 text-danger-700"
                        title="still marked recording but no chunk from either mic for over 10 minutes — the hourly reaper ends it after 30"
                      >
                        stalled · no chunk 10 min+
                      </span>
                    ) : isLive(s) ? (
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-caption font-semibold bg-even-pink-50 text-even-pink-700">
                        <span className="w-1.5 h-1.5 rounded-full bg-even-pink-600 animate-pulse" />
                        recording
                      </span>
                    ) : s.status === "ended" ? (
                      <span className="inline-block px-2 py-0.5 rounded-full text-caption font-semibold bg-success-100 text-success-700">
                        ended
                      </span>
                    ) : (
                      <span className="inline-block px-2 py-0.5 rounded-full text-caption font-semibold bg-even-ink-100 text-even-ink-500">
                        {s.status}
                      </span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
      </Disclosure>

      {/* ===== Rooms card (D5: managed here, never on Clinicians) =====
          B2 — this section had NO overflow-x-auto while the recordings section next to it did,
          so its 5-column table pushed the whole PAGE wide instead of scrolling inside its own
          box. Room creation, rename and PIN reset live in here: desk work, folded away on a
          tablet with the table (Part C). */}
      <Disclosure summary="Rooms" count={rooms ? `${rooms.length}` : null}>
      <section className="eta-card p-5 overflow-x-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-heading text-even-navy-800">Rooms</h2>
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="eta-btn-primary min-h-11 px-4 py-2 text-label"
          >
            + New room
          </button>
        </div>

        {showCreate && (
          <div className="mb-4 flex items-center gap-2">
            <input
              value={newRoomName}
              onChange={(e) => setNewRoomName(e.target.value)}
              placeholder="Room name, e.g. OPD 3"
              className="flex-1 min-h-11 rounded-xl border border-even-ink-200 bg-even-white px-3 py-2 text-base"
            />
            <button
              type="button"
              onClick={onCreateRoom}
              disabled={creating || newRoomName.trim().length < 2}
              className="eta-btn-primary min-h-11 px-4 py-2 text-label"
            >
              {creating ? "Creating…" : "Create"}
            </button>
          </div>
        )}

        {createdRoom && (
          <div className="mb-4 rounded-xl bg-even-blue-50 border border-even-blue-100 px-4 py-3 text-body text-even-navy-800">
            <b>{createdRoom.name}</b> created — login URL <code>/room/{createdRoom.slug}</code>, PIN{" "}
            <b className="tabular-nums">{createdRoom.pin}</b>. This PIN is shown once — note it down
            now.
            <button
              type="button"
              onClick={() => setCreatedRoom(null)}
              className={`${ROW_BTN} ml-2`}
            >
              dismiss
            </button>
          </div>
        )}
        {resetPin && (
          <div className="mb-4 rounded-xl bg-even-blue-50 border border-even-blue-100 px-4 py-3 text-body text-even-navy-800">
            New PIN for <b>{resetPin.name}</b>: <b className="tabular-nums">{resetPin.pin}</b> —
            shown once.
            <button
              type="button"
              onClick={() => setResetPin(null)}
              className={`${ROW_BTN} ml-2`}
            >
              dismiss
            </button>
          </div>
        )}

        <table className="w-full text-body">
          <thead>
            <tr className="text-left border-b border-even-ink-100">
              {["Room", "Login URL", "Status", "Last session", ""].map((h, i) => (
                <th
                  key={i}
                  className="py-2 px-2.5 text-meta uppercase tracking-wider text-even-ink-400 font-semibold"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rooms === null ? (
              <tr>
                <td colSpan={5} className="py-4 px-2.5 text-caption text-even-ink-400">
                  Loading…
                </td>
              </tr>
            ) : rooms.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-4 px-2.5 text-caption text-even-ink-400">
                  No rooms yet.
                </td>
              </tr>
            ) : (
              rooms.map((r) => (
                <tr key={r.id} className="border-b border-even-ink-50">
                  <td className="py-2.5 px-2.5 font-semibold text-even-navy-800">
                    {renaming?.id === r.id ? (
                      <span className="flex items-center gap-1.5">
                        <input
                          value={renaming.draft}
                          autoFocus
                          maxLength={64}
                          onChange={(e) => setRenaming({ id: r.id, draft: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void onRename(r.id, renaming.draft);
                            if (e.key === "Escape") { setRenaming(null); setRenameError(null); }
                          }}
                          className="min-h-11 rounded-lg border border-even-ink-200 bg-even-white px-3 py-2 text-base"
                        />
                        <button
                          type="button"
                          onClick={() => void onRename(r.id, renaming.draft)}
                          disabled={renaming.draft.trim().length < 2}
                          className={`${ROW_BTN} disabled:opacity-40`}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => { setRenaming(null); setRenameError(null); }}
                          className={`${ROW_BTN} text-even-ink-600`}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      r.name
                    )}
                    {renaming?.id === r.id && renameError ? (
                      <p className="mt-1 text-caption text-danger-700 font-normal">{renameError}</p>
                    ) : null}
                  </td>
                  <td className="py-2.5 px-2.5 font-mono text-caption">/room/{r.slug}</td>
                  <td className="py-2.5 px-2.5">
                    {r.disabled ? (
                      <span className="inline-block px-2 py-0.5 rounded-full text-caption font-semibold bg-even-ink-100 text-even-ink-500">
                        disabled
                      </span>
                    ) : (
                      <span className="inline-block px-2 py-0.5 rounded-full text-caption font-semibold bg-success-100 text-success-700">
                        active
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 px-2.5 text-caption text-even-ink-500">
                    {r.last_session_at
                      ? `${new Date(r.last_session_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} · ${r.last_session_status}`
                      : "—"}
                  </td>
                  <td className="py-2.5 px-2.5 text-right whitespace-nowrap">
                    {/* Rename lives HERE, beside Reset PIN and Disable — one place, not two.
                        It changes `name` and nothing else: the login URL is built from `slug`,
                        so no PIN changes and nobody has to sign in again. */}
                    {/* A3 — three bare text links, ~16px tall, separated only by ml-3: three
                        adjacent mis-taps waiting to happen, one of which resets a room's PIN.
                        Now real buttons with a 44pt hit area and a gap between them. */}
                    <span className="inline-flex flex-wrap items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => { setRenaming({ id: r.id, draft: r.name }); setRenameError(null); }}
                        className={ROW_BTN}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        onClick={() => onResetPin(r)}
                        className={ROW_BTN}
                      >
                        Reset PIN
                      </button>
                      <button
                        type="button"
                        onClick={() => onToggleDisabled(r)}
                        className={`${ROW_BTN} text-even-ink-600`}
                      >
                        {r.disabled ? "Enable" : "Disable"}
                      </button>
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <p className="mt-3 text-caption text-even-ink-400">
          Creating a room shows its PIN once (like admin-created doctor PINs). Rooms have no voice
          enrollment and never appear on the Clinicians page. Renaming a room changes only its
          display name — the login URL uses the slug, so PINs and sign-ins are unaffected.
        </p>
      </section>
      </Disclosure>
    </div>
  );
}

/**
 * PART C — the desk-work fold.
 *
 * Fleet cards are the primary product, so recordings and room administration are secondary on
 * every viewport. Both remain one 44px tap away and preserve their state after opening.
 */
function Disclosure({ summary, count, children }: { summary: string; count?: string | null; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full eta-card px-4 min-h-11 flex items-center justify-between gap-3 text-left active:bg-even-ink-50"
      >
        <span className="text-heading text-even-navy-800">{summary}</span>
        <span className="flex items-center gap-2 text-caption text-even-ink-400">
          {count ? <span>{count}</span> : null}
          <span aria-hidden="true" className="text-heading leading-none">{open ? "−" : "＋"}</span>
        </span>
      </button>

      <div className={`${open ? "block" : "hidden"} mt-3`}>{children}</div>
    </div>
  );
}
