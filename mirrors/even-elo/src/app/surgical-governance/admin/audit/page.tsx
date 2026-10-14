"use client";

import { useEffect, useState, useCallback } from "react";
import { AdminShell } from "@/components/AdminShell";

interface AuditRow {
  id: string;
  actor_position: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before_json: Record<string, unknown> | null;
  after_json: Record<string, unknown> | null;
  at: string;
}

const ACTION_PILL_STYLE: Record<string, string> = {
  create: "bg-stone-100 text-stone-700",
  overwrite: "bg-emerald-50 text-emerald-700",
  void: "bg-red-50 text-red-700",
  recompute: "bg-blue-50 text-blue-700",
  apply_weights: "bg-purple-50 text-purple-700",
  edit_stream: "bg-amber-50 text-amber-700",
  add_vc: "bg-stone-100 text-stone-700",
  edit_vc: "bg-stone-100 text-stone-700",
  delete_vc: "bg-red-50 text-red-700",
  edit_position: "bg-stone-100 text-stone-700",
  migrate: "bg-purple-50 text-purple-700",
};

export default function AdminAuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState("");
  const [entityFilter, setEntityFilter] = useState("");
  const [actorFilter, setActorFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (actionFilter) qs.set("action", actionFilter);
      if (entityFilter) qs.set("entity_type", entityFilter);
      if (actorFilter) qs.set("actor", actorFilter);
      qs.set("limit", "500");
      const r = await fetch(`/api/audit?${qs}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? "load failed");
      setRows(j.rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [actionFilter, entityFilter, actorFilter]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <AdminShell
      breadcrumbs={[{ label: "Admin", href: "/surgical-governance/admin" }, { label: "Audit log" }]}
      title="Audit log"
      subtitle="Append-only record of every observation, case, weight, and admin action. NABH HRM-11/12/13 defensibility."
    >
      <div className="flex items-center gap-3 mb-4 text-sm flex-wrap">
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="px-3 py-1.5 border border-stone-200 rounded-lg text-sm bg-white"
        >
          <option value="">All actions</option>
          <option value="create">create</option>
          <option value="overwrite">overwrite</option>
          <option value="void">void</option>
          <option value="recompute">recompute</option>
          <option value="apply_weights">apply_weights</option>
          <option value="edit_stream">edit_stream</option>
          <option value="add_vc">add_vc</option>
          <option value="edit_vc">edit_vc</option>
          <option value="delete_vc">delete_vc</option>
          <option value="migrate">migrate</option>
        </select>
        <select
          value={entityFilter}
          onChange={(e) => setEntityFilter(e.target.value)}
          className="px-3 py-1.5 border border-stone-200 rounded-lg text-sm bg-white"
        >
          <option value="">All entity types</option>
          <option value="observation">observation</option>
          <option value="case">case</option>
          <option value="vc">vc</option>
          <option value="weights">weights</option>
          <option value="stream">stream</option>
          <option value="position">position</option>
          <option value="system">system</option>
        </select>
        <input
          value={actorFilter}
          onChange={(e) => setActorFilter(e.target.value)}
          placeholder="Actor position…"
          className="px-3 py-1.5 border border-stone-200 rounded-lg text-sm bg-white"
        />
        <div className="flex-1" />
        <a
          href={`/api/audit?format=csv${actionFilter ? `&action=${actionFilter}` : ""}${entityFilter ? `&entity_type=${entityFilter}` : ""}${actorFilter ? `&actor=${actorFilter}` : ""}`}
          download
          className="text-sm px-3 py-1.5 rounded-lg border border-stone-200 hover:border-stone-300 bg-white"
        >
          Export CSV
        </a>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 mb-4 text-sm text-red-900">
          {error}
        </div>
      )}

      <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
        <div className="divide-y divide-stone-100">
          {loading && (
            <div className="px-5 py-6 text-sm text-stone-500 text-center">Loading…</div>
          )}
          {!loading && rows.length === 0 && (
            <div className="px-5 py-6 text-sm text-stone-500 text-center">No matching rows.</div>
          )}
          {!loading &&
            rows.map((r) => {
              const pillStyle = ACTION_PILL_STYLE[r.action] ?? "bg-stone-100 text-stone-700";
              const isExpanded = expanded === r.id;
              return (
                <div key={r.id} className="px-5 py-3 hover:bg-stone-50">
                  <div className="grid grid-cols-12 gap-3 items-center">
                    <div className="col-span-2 text-xs text-stone-500 num">
                      {new Date(r.at).toLocaleString()}
                    </div>
                    <div className="col-span-2">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${pillStyle}`}
                      >
                        {r.action}
                      </span>
                    </div>
                    <div className="col-span-2 text-sm font-medium">{r.actor_position}</div>
                    <div className="col-span-5 text-sm">
                      <span className="text-stone-500">{r.entity_type}</span>{" "}
                      <span className="font-mono text-xs text-stone-600">{r.entity_id}</span>
                    </div>
                    <div className="col-span-1 text-right">
                      <button
                        onClick={() => setExpanded(isExpanded ? null : r.id)}
                        className="text-xs text-stone-500 hover:text-stone-900"
                      >
                        {isExpanded ? "Hide" : "JSON"}
                      </button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <div>
                        <div className="text-[11px] font-medium text-stone-500 uppercase tracking-wider mb-1">
                          before
                        </div>
                        <pre className="text-[11px] bg-stone-50 border border-stone-200 rounded p-2 overflow-x-auto font-mono">
                          {r.before_json ? JSON.stringify(r.before_json, null, 2) : "—"}
                        </pre>
                      </div>
                      <div>
                        <div className="text-[11px] font-medium text-stone-500 uppercase tracking-wider mb-1">
                          after
                        </div>
                        <pre className="text-[11px] bg-stone-50 border border-stone-200 rounded p-2 overflow-x-auto font-mono">
                          {r.after_json ? JSON.stringify(r.after_json, null, 2) : "—"}
                        </pre>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      </div>
    </AdminShell>
  );
}
