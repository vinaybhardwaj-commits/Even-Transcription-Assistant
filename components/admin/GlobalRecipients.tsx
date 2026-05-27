"use client";

import * as React from "react";
import { Button } from "@/components/ui/Button";

type Role = "admin" | "records" | "finance" | "compliance" | "other";

type Recipient = {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  created_at: string;
};

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: "records", label: "Records" },
  { value: "admin", label: "Admin" },
  { value: "compliance", label: "Compliance" },
  { value: "finance", label: "Finance" },
  { value: "other", label: "Other" },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function GlobalRecipients() {
  const [items, setItems] = React.useState<Recipient[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch("/api/admin/recipients", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
      setItems((j as { recipients: Recipient[] }).recipients);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const onToggleActive = React.useCallback(
    async (r: Recipient) => {
      try {
        const res = await fetch(`/api/admin/recipients/${r.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active: !r.active }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
        }
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [load],
  );

  const onChangeRole = React.useCallback(
    async (r: Recipient, role: Role) => {
      try {
        const res = await fetch(`/api/admin/recipients/${r.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
        }
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [load],
  );

  const onDelete = React.useCallback(
    async (r: Recipient) => {
      if (!confirm(`Remove ${r.name} (${r.email}) from the global address book?`)) return;
      try {
        const res = await fetch(`/api/admin/recipients/${r.id}`, { method: "DELETE" });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
        }
        setItems((prev) => prev?.filter((x) => x.id !== r.id) ?? prev);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

  return (
    <section className="py-6 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-heading text-even-navy-800">Global address book</h2>
          <p className="text-caption text-even-ink-500">
            Org-wide contacts every doctor sees on their Send panel.
          </p>
        </div>
        <Button variant="primary" onClick={() => setAdding(true)}>+ Add global contact</Button>
      </div>

      {error ? <p className="text-body text-danger-700">{error}</p> : null}

      {items === null ? (
        <p className="text-body text-even-ink-500">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-body text-even-ink-500">No global contacts yet. Add one above.</p>
      ) : (
        <div className="rounded-xl border border-even-ink-100 bg-even-white overflow-hidden">
          <table className="w-full text-left">
            <thead className="text-caption uppercase tracking-wide text-even-ink-500 bg-even-ink-50/40">
              <tr>
                <th className="px-4 py-2 font-semibold">Name</th>
                <th className="px-4 py-2 font-semibold">Email</th>
                <th className="px-4 py-2 font-semibold">Role</th>
                <th className="px-4 py-2 font-semibold">Active</th>
                <th className="px-4 py-2 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="text-body">
              {items.map((r) => (
                <tr key={r.id} className={`border-t border-even-ink-100 ${r.active ? "" : "opacity-60"}`}>
                  <td className="px-4 py-2 text-even-navy-800">{r.name}</td>
                  <td className="px-4 py-2 text-even-ink-700">{r.email}</td>
                  <td className="px-4 py-2">
                    <select
                      value={r.role}
                      onChange={(e) => void onChangeRole(r, e.target.value as Role)}
                      className="text-caption rounded-md border border-even-ink-200 px-2 py-1"
                    >
                      {ROLE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-2">
                    <button
                      type="button"
                      onClick={() => void onToggleActive(r)}
                      className={`text-caption rounded-full px-2 py-0.5 ${r.active ? "bg-success-100 text-success-700" : "bg-even-ink-100 text-even-ink-700"}`}
                    >
                      {r.active ? "Active" : "Inactive"}
                    </button>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => void onDelete(r)}
                      className="text-caption text-danger-700 hover:underline"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding ? (
        <AddGlobalRecipientModal
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            void load();
          }}
        />
      ) : null}
    </section>
  );
}

function AddGlobalRecipientModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<Role>("records");
  const [submitting, setSubmitting] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const onSubmit = React.useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setErr(null);
      if (!EMAIL_RE.test(email)) {
        setErr("That email looks wrong.");
        return;
      }
      if (name.trim().length < 1) {
        setErr("Name is required.");
        return;
      }
      setSubmitting(true);
      try {
        const res = await fetch("/api/admin/recipients", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, email, role, active: true }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
        onCreated();
      } catch (e2) {
        setErr(e2 instanceof Error ? e2.message : String(e2));
        setSubmitting(false);
      }
    },
    [name, email, role, onCreated],
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
        <h3 className="text-heading text-even-navy-800">Add global contact</h3>
        <p className="text-caption text-even-ink-500">
          Visible on every doctor&apos;s Send panel.
        </p>
        <div>
          <label htmlFor="gn-name" className="block text-label text-even-navy-800 mb-1">Name</label>
          <input id="gn-name" type="text" value={name} onChange={(e) => setName(e.target.value)} required minLength={1}
            className="w-full rounded-md border border-even-ink-200 px-3 py-2 text-body focus:outline-none focus:ring-2 focus:ring-even-blue-300"
            placeholder="e.g. Records desk" />
        </div>
        <div>
          <label htmlFor="gn-email" className="block text-label text-even-navy-800 mb-1">Email</label>
          <input id="gn-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off"
            className="w-full rounded-md border border-even-ink-200 px-3 py-2 text-body focus:outline-none focus:ring-2 focus:ring-even-blue-300"
            placeholder="records@even.in" />
        </div>
        <div>
          <label htmlFor="gn-role" className="block text-label text-even-navy-800 mb-1">Role</label>
          <select id="gn-role" value={role} onChange={(e) => setRole(e.target.value as Role)}
            className="rounded-md border border-even-ink-200 px-3 py-2 text-body">
            {ROLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        {err ? <p className="text-caption text-danger-700">{err}</p> : null}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={submitting}
            className="text-label text-even-ink-500 hover:underline px-3 py-2">
            Cancel
          </button>
          <Button variant="primary" disabled={submitting}>
            {submitting ? "Adding…" : "Add"}
          </Button>
        </div>
      </form>
    </div>
  );
}
