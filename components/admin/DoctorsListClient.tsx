"use client";

/**
 * DoctorsListClient — Sprint 10 page at /admin/doctors. Lifts the
 * existing doctors table from AdminDashboard with one upgrade: each
 * row's name links to the new /admin/doctors/[id] detail page.
 */

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";

type Doctor = {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  url_slug: string;
  clinician_type?: string;
  status: "active" | "disabled" | "locked";
  pin_set_at: string | null;
  last_active_at: string | null;
  joined_at: string;
  deleted: boolean;
};
type Banner =
  | { kind: "info"; message: string; details?: string }
  | { kind: "error"; message: string };

export function DoctorsListClient() {
  const [doctors, setDoctors] = React.useState<Doctor[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [banner, setBanner] = React.useState<Banner | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [filter, setFilter] = React.useState<"all" | "active" | "disabled" | "locked">("all");

  const load = React.useCallback(async () => {
    try {
      const res = await fetch("/api/admin/doctors", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
      setDoctors((j as { doctors: Doctor[] }).doctors);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  const visible = (doctors ?? []).filter((d) =>
    filter === "all" ? true :
    filter === "active" ? d.status === "active" && !d.deleted :
    filter === "disabled" ? d.status === "disabled" || d.deleted :
    d.status === "locked"
  );
  const counts = (doctors ?? []).reduce(
    (a, d) => {
      a.all += 1;
      if (d.deleted)              a.disabled += 1;
      else if (d.status === "active")   a.active += 1;
      else if (d.status === "disabled") a.disabled += 1;
      else if (d.status === "locked")   a.locked += 1;
      return a;
    },
    { all: 0, active: 0, disabled: 0, locked: 0 },
  );

  return (
    <div className="space-y-6">
      {banner ? (
        <div
          className={`rounded-md border p-3 text-body ${
            banner.kind === "error"
              ? "border-danger-500 bg-danger-100/40 text-danger-700"
              : "border-success-500 bg-success-100/40 text-even-ink-800"
          }`}
        >
          <p className="font-semibold">{banner.message}</p>
          {banner.kind === "info" && banner.details ? (
            <p className="mt-1 text-caption text-even-ink-700 whitespace-pre-line font-mono">{banner.details}</p>
          ) : null}
          <button type="button" onClick={() => setBanner(null)} className="text-caption text-even-ink-500 hover:underline mt-2">Dismiss</button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {(["all", "active", "disabled", "locked"] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setFilter(k)}
            className={`px-2.5 py-1 rounded-full text-caption transition-colors ${
              filter === k ? "bg-even-navy-800 text-even-white" : "bg-even-ink-100 text-even-ink-700 hover:bg-even-ink-200"
            }`}
          >
            {k === "all" ? "All" : k[0]!.toUpperCase() + k.slice(1)} · {counts[k]}
          </button>
        ))}
        <div className="ml-auto">
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>+ Add doctor</Button>
        </div>
      </div>

      {error ? (
        <p className="text-body text-danger-700">Could not load: {error}</p>
      ) : !doctors ? (
        <p className="text-body text-even-ink-500">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="text-body text-even-ink-500">No doctors match this filter.</p>
      ) : (
        <div className="rounded-xl border border-even-ink-100 bg-even-white overflow-hidden">
          <table className="w-full text-left">
            <thead className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 bg-even-ink-50/40 border-b border-even-ink-100">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Name</th>
                <th className="px-4 py-2.5 font-semibold">Email</th>
                <th className="px-4 py-2.5 font-semibold">URL slug</th>
                <th className="px-4 py-2.5 font-semibold">Type</th>
                <th className="px-4 py-2.5 font-semibold">Status</th>
                <th className="px-4 py-2.5 font-semibold">Last active</th>
              </tr>
            </thead>
            <tbody className="text-body">
              {visible.map((d) => (
                <tr
                  key={d.id}
                  className={`border-t border-even-ink-100 hover:bg-even-ink-50/40 ${d.deleted ? "opacity-50" : ""}`}
                >
                  <td className="px-4 py-2">
                    <Link
                      href={d.deleted ? `/admin/doctors/${d.id}` : `/admin/doctors/${d.id}/voice`}
                      className="text-even-navy-800 hover:underline font-medium"
                      title={d.deleted ? "View doctor" : "Set up / re-record voice for diarization"}
                    >
                      {d.full_name}
                    </Link>
                    <div className="flex items-center gap-2">
                      <span className="text-caption text-even-ink-400 font-mono">{d.id}</span>
                      <Link href={`/admin/doctors/${d.id}`} className="text-caption text-even-blue-600 hover:underline">Details</Link>
                    </div>
                  </td>
                  <td className="px-4 py-2 text-even-ink-700">{d.email}</td>
                  <td className="px-4 py-2 text-caption text-even-ink-500 font-mono">/{d.url_slug}</td>
                  <td className="px-4 py-2">
                    <TypePill type={d.clinician_type} />
                  </td>
                  <td className="px-4 py-2">
                    <StatusPill status={d.status} deleted={d.deleted} />
                  </td>
                  <td className="px-4 py-2 text-caption text-even-ink-500" suppressHydrationWarning>
                    {d.last_active_at ? new Date(d.last_active_at).toLocaleString("en-IN") : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating ? (
        <CreateDoctorModal
          onClose={() => setCreating(false)}
          onCreated={(d, pin, loginUrl) => {
            setCreating(false);
            setBanner({
              kind: "info",
              message: `Doctor created: ${d.full_name}`,
              details: `PIN: ${pin}    Login URL: ${loginUrl}    (Share both. PIN is shown once.)`,
            });
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function TypePill({ type }: { type?: string }) {
  const t = type ?? "physician";
  const label = t.charAt(0).toUpperCase() + t.slice(1);
  return <span className="text-caption rounded-full px-2 py-0.5 bg-even-ink-100 text-even-ink-700">{label}</span>;
}

function StatusPill({ status, deleted }: { status: string; deleted: boolean }) {
  if (deleted)     return <span className="text-caption rounded-full px-2 py-0.5 bg-even-ink-100 text-even-ink-500">Deleted</span>;
  if (status === "active")   return <span className="text-caption rounded-full px-2 py-0.5 bg-success-100 text-success-700">Active</span>;
  if (status === "disabled") return <span className="text-caption rounded-full px-2 py-0.5 bg-even-ink-100 text-even-ink-700">Disabled</span>;
  if (status === "locked")   return <span className="text-caption rounded-full px-2 py-0.5 bg-warning-100 text-warning-700">Locked</span>;
  return <span className="text-caption">{status}</span>;
}

function CreateDoctorModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (d: Doctor, pin: string, loginUrl: string) => void;
}) {
  const [fullName, setFullName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [clinicianType, setClinicianType] = React.useState("physician");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const onSubmit = React.useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch("/api/admin/doctors", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ full_name: fullName, email, phone: phone || undefined, clinician_type: clinicianType }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
        const payload = j as { doctor: Doctor; pin_plaintext: string; login_url: string };
        onCreated(payload.doctor, payload.pin_plaintext, payload.login_url);
      } catch (e2) {
        setError(e2 instanceof Error ? e2.message : String(e2));
        setSubmitting(false);
      }
    },
    [fullName, email, phone, clinicianType, onCreated],
  );

  return (
    <div className="fixed inset-0 z-40 bg-even-ink-800/40 backdrop-blur-sm flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <form onSubmit={onSubmit} className="rounded-xl bg-even-white border border-even-ink-100 p-6 max-w-md w-full shadow-card-hover space-y-3">
        <h3 className="text-heading text-even-navy-800">Add clinician</h3>
        <p className="text-caption text-even-ink-500">URL slug + PIN auto-generated. PIN is shown once.</p>
        <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Full name" required minLength={2}
          className="w-full rounded-md border border-even-ink-200 px-3 py-2 text-body focus:outline-none focus:ring-2 focus:ring-even-blue-300" />
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" required autoComplete="off"
          className="w-full rounded-md border border-even-ink-200 px-3 py-2 text-body focus:outline-none focus:ring-2 focus:ring-even-blue-300" />
        <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="phone (optional)" autoComplete="off"
          className="w-full rounded-md border border-even-ink-200 px-3 py-2 text-body focus:outline-none focus:ring-2 focus:ring-even-blue-300" />
        <select value={clinicianType} onChange={(e) => setClinicianType(e.target.value)} aria-label="Clinician type"
          className="w-full rounded-md border border-even-ink-200 px-3 py-2 text-body focus:outline-none focus:ring-2 focus:ring-even-blue-300">
          <option value="physician">Physician</option>
          <option value="dietitian">Dietitian</option>
          <option value="physiotherapist">Physiotherapist</option>
        </select>
        {error ? <p className="text-caption text-danger-700">{error}</p> : null}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={submitting} className="text-label text-even-ink-500 hover:underline px-3 py-2">Cancel</button>
          <button type="submit" disabled={submitting} className="px-4 py-2 rounded-md bg-even-blue-600 hover:bg-even-blue-700 disabled:bg-even-blue-300 text-white text-label">
            {submitting ? "Creating…" : "Create clinician"}
          </button>
        </div>
      </form>
    </div>
  );
}
