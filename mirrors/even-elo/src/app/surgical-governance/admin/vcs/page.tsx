"use client";

import { useEffect, useState, useCallback } from "react";
import { AdminShell } from "@/components/AdminShell";
import { getCurrentPosition } from "@/lib/position";

interface VC {
  id: string;
  full_name: string;
  specialty: string;
  registration_no: string | null;
  status: "active" | "suspended" | "terminated";
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export default function AdminVCsPage() {
  const [vcs, setVcs] = useState<VC[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState<VC | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/vcs?status=${showAll ? "all" : "active"}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? "load failed");
      setVcs(j.vcs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [showAll]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <AdminShell
      breadcrumbs={[{ label: "Admin", href: "/surgical-governance/admin" }, { label: "Visiting Consultants" }]}
      title="Visiting Consultants"
      subtitle={`${vcs.length} ${showAll ? "total" : "active"} · roster of surgeons operating at EHRC under privileging`}
      actions={
        <>
          <label className="text-xs flex items-center gap-2 text-stone-600 mr-2">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              className="accent-brand"
            />
            Include suspended / terminated
          </label>
          <button
            onClick={() => setCreating(true)}
            className="bg-brand text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-brand-hover transition"
          >
            + Add VC
          </button>
        </>
      }
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
              <th className="px-4 py-3">Surgeon</th>
              <th className="px-4 py-3">Specialty</th>
              <th className="px-4 py-3">Registration</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {loading && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-stone-500">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && vcs.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-stone-500">
                  No VCs yet. Click <span className="font-medium">+ Add VC</span> to seed the roster.
                </td>
              </tr>
            )}
            {!loading &&
              vcs.map((vc) => (
                <tr key={vc.id} className="hover:bg-stone-50 text-sm">
                  <td className="px-4 py-3 font-medium">{vc.full_name}</td>
                  <td className="px-4 py-3 text-stone-600">{vc.specialty}</td>
                  <td className="px-4 py-3 text-stone-500 font-mono text-xs">
                    {vc.registration_no ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill status={vc.status} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setEditing(vc)}
                      className="text-xs text-brand hover:underline mr-3"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {(creating || editing) && (
        <VCDialog
          vc={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            load();
          }}
        />
      )}
    </AdminShell>
  );
}

function StatusPill({ status }: { status: VC["status"] }) {
  const styles: Record<VC["status"], string> = {
    active: "bg-emerald-50 text-emerald-700",
    suspended: "bg-amber-50 text-amber-700",
    terminated: "bg-stone-100 text-stone-600",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${styles[status]}`}>
      {status}
    </span>
  );
}

function VCDialog({
  vc,
  onClose,
  onSaved,
}: {
  vc: VC | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [fullName, setFullName] = useState(vc?.full_name ?? "");
  const [specialty, setSpecialty] = useState(vc?.specialty ?? "");
  const [registrationNo, setRegistrationNo] = useState(vc?.registration_no ?? "");
  const [notes, setNotes] = useState(vc?.notes ?? "");
  const [status, setStatus] = useState<VC["status"]>(vc?.status ?? "active");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actor = getCurrentPosition() ?? "Committee Admin";

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const isCreate = !vc;
      const url = isCreate ? "/api/vcs" : `/api/vcs/${vc.id}`;
      const method = isCreate ? "POST" : "PATCH";
      const body = isCreate
        ? {
            full_name: fullName,
            specialty,
            registration_no: registrationNo || null,
            notes: notes || null,
            created_by_position: actor,
          }
        : {
            full_name: fullName,
            specialty,
            registration_no: registrationNo || null,
            notes: notes || null,
            status,
            actor_position: actor,
          };
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
          <h2 className="text-lg font-semibold">{vc ? "Edit VC" : "Add Visiting Consultant"}</h2>
          <p className="text-xs text-stone-500 mt-0.5">
            Stamped as <span className="font-medium text-stone-700">{actor}</span>
          </p>
        </div>
        <div className="px-6 py-5 space-y-4">
          <Field label="Full name" required>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white"
              placeholder="e.g. Dr Manoj Kumar"
            />
          </Field>
          <Field label="Specialty" required>
            <input
              type="text"
              value={specialty}
              onChange={(e) => setSpecialty(e.target.value)}
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white"
              placeholder="e.g. General Surgery"
            />
          </Field>
          <Field label="Registration number">
            <input
              type="text"
              value={registrationNo ?? ""}
              onChange={(e) => setRegistrationNo(e.target.value)}
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white font-mono"
              placeholder="e.g. MCI-12345"
            />
          </Field>
          {vc && (
            <Field label="Status">
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as VC["status"])}
                className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white"
              >
                <option value="active">active</option>
                <option value="suspended">suspended</option>
                <option value="terminated">terminated</option>
              </select>
            </Field>
          )}
          <Field label="Notes">
            <textarea
              value={notes ?? ""}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white"
            />
          </Field>
          {error && <div className="text-sm text-red-700">{error}</div>}
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
            disabled={saving || !fullName.trim() || !specialty.trim()}
            className="text-sm px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand-hover transition disabled:opacity-50"
          >
            {saving ? "Saving…" : vc ? "Save changes" : "Add VC"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-stone-700 mb-1.5">
        {label}
        {required && <span className="text-red-500 ml-1">*</span>}
      </span>
      {children}
    </label>
  );
}
