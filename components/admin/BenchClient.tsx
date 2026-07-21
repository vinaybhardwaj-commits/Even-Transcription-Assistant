"use client";

/**
 * BenchClient — admin Bench page body (Room-Bench PRD §3.5; mockup
 * screens 4 & 6): sessions table with rollups + live badge (last verified
 * chunk < 7 min old), and the Rooms card (create → slug + PIN shown once;
 * reset PIN; disable/enable). Rooms never appear on the Clinicians page.
 */

import * as React from "react";
import Link from "next/link";

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
    const t = setInterval(() => void load(), 60_000);
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

  return (
    <div className="space-y-6">
      {error && (
        <p className="text-caption text-danger-700" role="alert">
          {error}
        </p>
      )}

      {/* ===== Sessions ===== */}
      <section className="eta-card p-5 overflow-x-auto">
        <table className="w-full text-body">
          <thead>
            <tr className="text-left border-b border-even-ink-100">
              {["Room", "Session", "Date", "Duration", "Chunks", "Verified", "Gaps", "Size", "Status"].map(
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
                <td colSpan={9} className="py-6 px-2.5 text-caption text-even-ink-400">
                  Loading…
                </td>
              </tr>
            ) : sessions.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-6 px-2.5 text-caption text-even-ink-400">
                  No bench sessions yet. Create a room below, sign in at its /room URL and start a
                  recording day.
                </td>
              </tr>
            ) : (
              sessions.map((s) => (
                <tr key={s.id} className="border-b border-even-ink-50 hover:bg-even-ink-50">
                  <td className="py-2.5 px-2.5 font-semibold text-even-navy-800">{s.room_name}</td>
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
                    {isLive(s) ? (
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

      {/* ===== Rooms card (D5: managed here, never on Clinicians) ===== */}
      <section className="eta-card p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-heading text-even-navy-800">Rooms</h2>
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="eta-btn-primary px-4 py-2 text-label"
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
              className="flex-1 rounded-xl border border-even-ink-200 bg-even-white px-3 py-2 text-body"
            />
            <button
              type="button"
              onClick={onCreateRoom}
              disabled={creating || newRoomName.trim().length < 2}
              className="eta-btn-primary px-4 py-2 text-label"
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
              className="ml-3 text-even-blue-700 underline text-caption"
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
              className="ml-3 text-even-blue-700 underline text-caption"
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
                  <td className="py-2.5 px-2.5 font-semibold text-even-navy-800">{r.name}</td>
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
                    <button
                      type="button"
                      onClick={() => onResetPin(r)}
                      className="text-even-blue-700 text-caption hover:underline"
                    >
                      Reset PIN
                    </button>
                    <button
                      type="button"
                      onClick={() => onToggleDisabled(r)}
                      className="ml-3 text-even-ink-500 text-caption hover:underline"
                    >
                      {r.disabled ? "Enable" : "Disable"}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <p className="mt-3 text-caption text-even-ink-400">
          Creating a room shows its PIN once (like admin-created doctor PINs). Rooms have no voice
          enrollment and never appear on the Clinicians page.
        </p>
      </section>
    </div>
  );
}
