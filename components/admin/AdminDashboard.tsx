"use client";

import * as React from "react";

type Doctor = {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  url_slug: string;
  status: "active" | "disabled" | "locked";
  pin_set_at: string | null;
  last_active_at: string | null;
  joined_at: string;
  deleted: boolean;
};

type Banner =
  | { kind: "info"; message: string; details?: string }
  | { kind: "error"; message: string };

export function AdminDashboard({ adminEmail }: { adminEmail: string }) {
  const [doctors, setDoctors] = React.useState<Doctor[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [banner, setBanner] = React.useState<Banner | null>(null);

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

  React.useEffect(() => {
    void load();
  }, [load]);

  const onLogout = React.useCallback(async () => {
    await fetch("/api/admin/logout", { method: "POST" });
    window.location.reload();
  }, []);

  const onResetPin = React.useCallback(
    async (d: Doctor) => {
      if (!confirm(`Reset PIN for ${d.full_name} (${d.email})?`)) return;
      try {
        const res = await fetch(`/api/admin/doctors/${d.id}/reset-pin`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const j = await res.json();
        if (!res.ok) throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
        const { pin_plaintext, login_url } = j as { pin_plaintext: string; login_url: string };
        setBanner({
          kind: "info",
          message: `PIN reset for ${d.full_name}`,
          details: `New PIN: ${pin_plaintext}    Login URL: ${login_url}    (Share both with the doctor; PIN is shown once.)`,
        });
      } catch (e) {
        setBanner({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    },
    [],
  );

  const onToggleStatus = React.useCallback(
    async (d: Doctor) => {
      const next = d.status === "active" ? "disabled" : "active";
      try {
        const res = await fetch(`/api/admin/doctors/${d.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: next }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
        }
        await load();
      } catch (e) {
        setBanner({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    },
    [load],
  );

  return (
    <main className="min-h-screen bg-even-ink-50">
      <header className="bg-even-white border-b border-even-ink-100 px-4 py-3 flex items-center justify-between">
        <div>
          <h1 className="text-label text-even-navy-800">Even Hospital · Admin</h1>
          <p className="text-caption text-even-ink-500">{adminEmail}</p>
        </div>
        <button
          type="button"
          onClick={onLogout}
          className="text-label text-even-blue-600 hover:underline"
        >
          Sign out
        </button>
      </header>

      <div className="px-4 py-6 max-w-5xl mx-auto space-y-4">
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
            <button
              type="button"
              onClick={() => setBanner(null)}
              className="text-caption text-even-ink-500 hover:underline mt-2"
            >
              Dismiss
            </button>
          </div>
        ) : null}

        <div className="flex items-center justify-between">
          <h2 className="text-heading text-even-navy-800">Doctors</h2>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="px-4 py-2 rounded-md bg-even-blue-600 hover:bg-even-blue-700 text-white text-label"
          >
            + Add doctor
          </button>
        </div>

        {error ? (
          <p className="text-body text-danger-700">Could not load: {error}</p>
        ) : !doctors ? (
          <p className="text-body text-even-ink-500">Loading…</p>
        ) : doctors.length === 0 ? (
          <p className="text-body text-even-ink-500">No doctors yet. Add the first.</p>
        ) : (
          <div className="rounded-xl border border-even-ink-100 bg-even-white overflow-hidden">
            <table className="w-full text-left">
              <thead className="text-caption uppercase tracking-wide text-even-ink-500 bg-even-ink-50/40">
                <tr>
                  <th className="px-4 py-2 font-semibold">Name</th>
                  <th className="px-4 py-2 font-semibold">Email</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                  <th className="px-4 py-2 font-semibold">Last active</th>
                  <th className="px-4 py-2 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="text-body">
                {doctors.map((d) => (
                  <tr
                    key={d.id}
                    className={`border-t border-even-ink-100 ${d.deleted ? "opacity-50" : ""}`}
                  >
                    <td className="px-4 py-2">
                      <a
                        href={`/${d.url_slug}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-even-navy-800 hover:underline"
                      >
                        {d.full_name}
                      </a>
                      <div className="text-caption text-even-ink-400">{d.url_slug}</div>
                    </td>
                    <td className="px-4 py-2 text-even-ink-700">{d.email}</td>
                    <td className="px-4 py-2">
                      <StatusPill status={d.status} deleted={d.deleted} />
                    </td>
                    <td className="px-4 py-2 text-caption text-even-ink-500">
                      {d.last_active_at ? new Date(d.last_active_at).toLocaleString("en-IN") : "—"}
                    </td>
                    <td className="px-4 py-2 text-right space-x-3 text-caption">
                      {d.deleted ? null : (
                        <>
                          <button
                            type="button"
                            onClick={() => void onResetPin(d)}
                            className="text-even-blue-600 hover:underline"
                          >
                            Reset PIN
                          </button>
                          <button
                            type="button"
                            onClick={() => void onToggleStatus(d)}
                            className="text-even-blue-600 hover:underline"
                          >
                            {d.status === "active" ? "Disable" : "Enable"}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

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
    </main>
  );
}

function StatusPill({ status, deleted }: { status: string; deleted: boolean }) {
  if (deleted) {
    return <span className="text-caption rounded-full px-2 py-0.5 bg-even-ink-100 text-even-ink-500">Deleted</span>;
  }
  if (status === "active") {
    return <span className="text-caption rounded-full px-2 py-0.5 bg-success-100 text-success-700">Active</span>;
  }
  if (status === "disabled") {
    return <span className="text-caption rounded-full px-2 py-0.5 bg-even-ink-100 text-even-ink-700">Disabled</span>;
  }
  if (status === "locked") {
    return <span className="text-caption rounded-full px-2 py-0.5 bg-warning-100 text-warning-700">Locked</span>;
  }
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
          body: JSON.stringify({ full_name: fullName, email, phone: phone || undefined }),
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
    [fullName, email, phone, onCreated],
  );

  return (
    <div
      className="fixed inset-0 z-40 bg-even-ink-800/40 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <form
        onSubmit={onSubmit}
        className="rounded-xl bg-even-white border border-even-ink-100 p-6 max-w-md w-full shadow-card-hover space-y-3"
      >
        <h3 className="text-heading text-even-navy-800">Add doctor</h3>
        <p className="text-caption text-even-ink-500">
          The URL slug + PIN are generated automatically. You&apos;ll see the PIN once.
        </p>
        <div>
          <label htmlFor="dname" className="block text-label text-even-navy-800 mb-1">Full name</label>
          <input
            id="dname"
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
            minLength={2}
            className="w-full rounded-md border border-even-ink-200 px-3 py-2 text-body focus:outline-none focus:ring-2 focus:ring-even-blue-300"
            placeholder="e.g. Rebecca Gladvin"
          />
        </div>
        <div>
          <label htmlFor="demail" className="block text-label text-even-navy-800 mb-1">Email</label>
          <input
            id="demail"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="off"
            className="w-full rounded-md border border-even-ink-200 px-3 py-2 text-body focus:outline-none focus:ring-2 focus:ring-even-blue-300"
            placeholder="rebecca.gladvin@even.in"
          />
        </div>
        <div>
          <label htmlFor="dphone" className="block text-label text-even-navy-800 mb-1">Phone (optional)</label>
          <input
            id="dphone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            autoComplete="off"
            className="w-full rounded-md border border-even-ink-200 px-3 py-2 text-body focus:outline-none focus:ring-2 focus:ring-even-blue-300"
            placeholder="+91 …"
          />
        </div>
        {error ? <p className="text-caption text-danger-700">{error}</p> : null}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-label text-even-ink-500 hover:underline px-3 py-2"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 rounded-md bg-even-blue-600 hover:bg-even-blue-700 disabled:bg-even-blue-300 text-white text-label"
          >
            {submitting ? "Creating…" : "Create doctor"}
          </button>
        </div>
      </form>
    </div>
  );
}
