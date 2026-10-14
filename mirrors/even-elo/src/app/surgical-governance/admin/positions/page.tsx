"use client";

import { useEffect, useState, useCallback } from "react";
import { AdminShell } from "@/components/AdminShell";
import { getCurrentPosition } from "@/lib/position";

interface Position {
  id: string;
  position_name: string;
  team: string;
  description: string | null;
  active: boolean;
}

export default function AdminPositionsPage() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Position | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/positions");
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? "load failed");
      setPositions(j.positions);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <AdminShell
      breadcrumbs={[{ label: "Admin", href: "/surgical-governance/admin" }, { label: "Positions" }]}
      title="Positions"
      subtitle="Audit by position, not by individual person — every observation/case write is stamped with one of these roles"
    >
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 mb-4 text-sm text-red-900">
          {error}
        </div>
      )}

      <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
        <table className="w-full">
          <thead className="bg-stone-50">
            <tr className="text-left text-[11px] font-medium text-stone-500 tracking-wider uppercase">
              <th className="px-4 py-3">Position</th>
              <th className="px-4 py-3">Team</th>
              <th className="px-4 py-3">Description</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {loading && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-stone-500">
                  Loading…
                </td>
              </tr>
            )}
            {!loading &&
              positions.map((p) => (
                <tr key={p.id} className="hover:bg-stone-50 text-sm">
                  <td className="px-4 py-3 font-medium">{p.position_name}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-brand-softer text-[11px] font-medium text-brand">
                      {p.team}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-stone-600">{p.description ?? "—"}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setEditing(p)}
                      className="text-xs text-brand hover:underline"
                    >
                      Edit description
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <PositionDialog
          position={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </AdminShell>
  );
}

function PositionDialog({
  position,
  onClose,
  onSaved,
}: {
  position: Position;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [description, setDescription] = useState(position.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actor = getCurrentPosition() ?? "Committee Admin";

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/positions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          position_name: position.position_name,
          description,
          actor_position: actor,
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? "save failed");
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden">
        <div className="px-6 py-5 border-b border-stone-100">
          <h2 className="text-lg font-semibold">Edit position description</h2>
          <p className="text-xs text-stone-500 mt-0.5">
            <span className="font-medium text-stone-700">{position.position_name}</span> · team:{" "}
            {position.team}
          </p>
        </div>
        <div className="px-6 py-5">
          <label className="block">
            <span className="block text-xs font-medium text-stone-700 mb-1.5">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white"
              placeholder="What this position is responsible for in the audit context"
            />
          </label>
          {error && <div className="text-sm text-red-700 mt-3">{error}</div>}
        </div>
        <div className="px-6 py-4 bg-stone-50 border-t border-stone-100 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="text-sm px-3 py-1.5 rounded-lg border border-stone-200 hover:border-stone-300 transition"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="text-sm px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand-hover transition disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
