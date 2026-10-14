"use client";

import { useEffect, useState, useCallback } from "react";
import { AdminShell } from "@/components/AdminShell";
import { getCurrentPosition } from "@/lib/position";

interface StreamRow {
  id: string;
  label: string;
  component: string;
  team_owner: string;
  data_type: string;
  default_rule: string;
  direction: string;
  floor_value: number | null;
  target_value: number | null;
  requires_reason_when: string | null;
  active: boolean;
}

export default function AdminStreamsPage() {
  const [streams, setStreams] = useState<StreamRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<StreamRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/streams?active=false");
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? "load failed");
      setStreams(j.streams);
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
      breadcrumbs={[{ label: "Admin", href: "/surgical-governance/admin" }, { label: "Streams" }]}
      title="Stream catalogue"
      subtitle="18 streams across 3 components. Edit floor / target to recalibrate the 0–100 mapping for any stream."
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
              <th className="px-4 py-3">Stream</th>
              <th className="px-4 py-3">Component</th>
              <th className="px-4 py-3">Team</th>
              <th className="px-4 py-3">Data type</th>
              <th className="px-4 py-3">Default</th>
              <th className="px-4 py-3">Direction</th>
              <th className="px-4 py-3">Floor / Target</th>
              <th className="px-4 py-3">Active</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {loading && (
              <tr>
                <td colSpan={9} className="px-4 py-6 text-center text-sm text-stone-500">
                  Loading…
                </td>
              </tr>
            )}
            {!loading &&
              streams.map((s) => (
                <tr key={s.id} className="hover:bg-stone-50 text-sm">
                  <td className="px-4 py-3">
                    <div className="font-medium">{s.label}</div>
                    <div className="font-mono text-[10px] text-stone-500">{s.id}</div>
                  </td>
                  <td className="px-4 py-3 text-stone-600 capitalize">{s.component}</td>
                  <td className="px-4 py-3 text-stone-600">{s.team_owner}</td>
                  <td className="px-4 py-3 text-stone-600">{s.data_type}</td>
                  <td className="px-4 py-3 text-stone-600">{s.default_rule}</td>
                  <td className="px-4 py-3 text-stone-600">{s.direction}</td>
                  <td className="px-4 py-3 num">
                    {s.floor_value !== null && s.target_value !== null ? (
                      <span>
                        {s.floor_value} / {s.target_value}
                      </span>
                    ) : (
                      <span className="text-stone-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${
                        s.active ? "bg-emerald-50 text-emerald-700" : "bg-stone-100 text-stone-500"
                      }`}
                    >
                      {s.active ? "active" : "inactive"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {s.data_type !== "derived" && (
                      <button
                        onClick={() => setEditing(s)}
                        className="text-xs text-brand hover:underline"
                      >
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <StreamEditDialog
          stream={editing}
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

function StreamEditDialog({
  stream,
  onClose,
  onSaved,
}: {
  stream: StreamRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [floor, setFloor] = useState<string>(
    stream.floor_value !== null ? String(stream.floor_value) : "",
  );
  const [target, setTarget] = useState<string>(
    stream.target_value !== null ? String(stream.target_value) : "",
  );
  const [active, setActive] = useState(stream.active);
  const [recomputeAll, setRecomputeAll] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actor = getCurrentPosition() ?? "Committee Admin";

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/streams/${stream.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          floor_value: floor === "" ? null : parseFloat(floor),
          target_value: target === "" ? null : parseFloat(target),
          active,
          actor_position: actor,
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? "save failed");

      if (recomputeAll) {
        const rr = await fetch("/api/admin/recompute?all=true", { method: "POST" });
        const rj = await rr.json();
        if (!rj.ok) throw new Error(rj.error ?? "recompute failed");
      }
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
          <h2 className="text-lg font-semibold">Edit stream</h2>
          <p className="text-xs text-stone-500 mt-0.5">
            <span className="font-medium text-stone-700">{stream.label}</span> ·{" "}
            <span className="font-mono text-[10px]">{stream.id}</span> · {stream.direction}
          </p>
        </div>
        <div className="px-6 py-5 space-y-4">
          {stream.data_type === "numeric" && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <label className="block">
                  <span className="block text-xs font-medium text-stone-700 mb-1.5">
                    Floor (mapped to 0)
                  </span>
                  <input
                    type="number"
                    step="any"
                    value={floor}
                    onChange={(e) => setFloor(e.target.value)}
                    className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white font-mono"
                  />
                </label>
                <label className="block">
                  <span className="block text-xs font-medium text-stone-700 mb-1.5">
                    Target (mapped to 100)
                  </span>
                  <input
                    type="number"
                    step="any"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white font-mono"
                  />
                </label>
              </div>
            </>
          )}
          {stream.data_type !== "numeric" && (
            <div className="text-sm text-stone-500">
              Floor / target only apply to numeric streams. This stream is{" "}
              <span className="font-medium text-stone-700">{stream.data_type}</span>.
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="accent-brand"
            />
            Active (deactivating excludes from recomputes)
          </label>
          <label className="flex items-center gap-2 text-sm pt-2 border-t border-stone-100">
            <input
              type="checkbox"
              checked={recomputeAll}
              onChange={(e) => setRecomputeAll(e.target.checked)}
              className="accent-brand"
            />
            Recompute all active VCs after saving
          </label>
          {error && <div className="text-sm text-red-700">{error}</div>}
        </div>
        <div className="px-6 py-4 bg-stone-50 border-t border-stone-100 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="text-sm px-3 py-1.5 rounded-lg border border-stone-200 hover:border-stone-300"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="text-sm px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand-hover disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
