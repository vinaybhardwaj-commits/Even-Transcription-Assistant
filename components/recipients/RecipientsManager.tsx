"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

type Role = "admin" | "records" | "finance" | "compliance" | "other";

type Recipient = {
  id: string;
  email: string;
  name: string;
  role: Role;
  set_by: string;
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

export function RecipientsManager({ slug }: { slug: string }) {
  const router = useRouter();
  const [items, setItems] = React.useState<Recipient[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch(`/${slug}/api/recipients`, { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
      setItems((j as { recipients: Recipient[] }).recipients);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [slug]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // ----- Add form -----
  const [addName, setAddName] = React.useState("");
  const [addEmail, setAddEmail] = React.useState("");
  const [addRole, setAddRole] = React.useState<Role>("other");
  const [addError, setAddError] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);

  const onAdd = React.useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setAddError(null);
      if (!EMAIL_RE.test(addEmail)) {
        setAddError("That email looks wrong.");
        return;
      }
      if (addName.trim().length < 1) {
        setAddError("Name is required.");
        return;
      }
      setAdding(true);
      try {
        const res = await fetch(`/${slug}/api/recipients`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: addEmail, name: addName, role: addRole }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
        setAddName(""); setAddEmail(""); setAddRole("other");
        await load();
      } catch (e) {
        setAddError(e instanceof Error ? e.message : String(e));
      } finally {
        setAdding(false);
      }
    },
    [addName, addEmail, addRole, slug, load],
  );

  const onDelete = React.useCallback(
    async (r: Recipient) => {
      if (!confirm(`Remove ${r.name} (${r.email}) from your contacts?`)) return;
      try {
        const res = await fetch(`/${slug}/api/recipients/${r.id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
        }
        setItems((prev) => (prev ? prev.filter((x) => x.id !== r.id) : prev));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [slug],
  );

  const onChangeRole = React.useCallback(
    async (r: Recipient, role: Role) => {
      try {
        const res = await fetch(`/${slug}/api/recipients/${r.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
        }
        const j = (await res.json()) as { recipient: Recipient };
        setItems((prev) => (prev ? prev.map((x) => (x.id === r.id ? j.recipient : x)) : prev));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [slug],
  );

  return (
    <main className="min-h-screen bg-even-ink-50">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-even-ink-100 bg-even-white/90 px-4 py-3 backdrop-blur">
        <button
          type="button"
          onClick={() => router.push(`/${slug}`)}
          className="text-label text-even-blue-600 hover:underline"
        >
          ‹ Home
        </button>
        <h1 className="text-label text-even-navy-800">My contacts</h1>
        <span className="text-caption text-even-ink-400">
          {items ? `${items.length}` : "…"}
        </span>
      </header>

      <div className="px-4 py-6 max-w-2xl mx-auto space-y-6">
        <form onSubmit={onAdd} className="rounded-2xl border border-even-ink-100 bg-even-white p-4 shadow-soft space-y-3">
          <h2 className="text-heading text-even-navy-800">Add contact</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="rn-name" className="block text-label text-even-navy-800 mb-1">Name</label>
              <input
                id="rn-name"
                type="text"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                placeholder="e.g. Records desk"
                className="w-full rounded-xl border border-even-ink-200 px-3 py-2 text-body focus:outline-none focus:ring-2 focus:ring-even-blue-200"
              />
            </div>
            <div>
              <label htmlFor="rn-email" className="block text-label text-even-navy-800 mb-1">Email</label>
              <input
                id="rn-email"
                type="email"
                value={addEmail}
                onChange={(e) => setAddEmail(e.target.value)}
                placeholder="records@even.in"
                autoComplete="off"
                className="w-full rounded-xl border border-even-ink-200 px-3 py-2 text-body focus:outline-none focus:ring-2 focus:ring-even-blue-200"
              />
            </div>
          </div>
          <div>
            <label htmlFor="rn-role" className="block text-label text-even-navy-800 mb-1">Role</label>
            <select
              id="rn-role"
              value={addRole}
              onChange={(e) => setAddRole(e.target.value as Role)}
              className="rounded-xl border border-even-ink-200 px-3 py-2 text-body focus:outline-none focus:ring-2 focus:ring-even-blue-200"
            >
              {ROLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          {addError ? <p className="text-caption text-danger-700">{addError}</p> : null}
          <div className="flex justify-end">
            <Button variant="primary" disabled={adding}>{adding ? "Adding…" : "Add contact"}</Button>
          </div>
        </form>

        {error ? <p className="text-body text-danger-700">{error}</p> : null}

        {items === null ? (
          <p className="text-body text-even-ink-500">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-body text-even-ink-500 text-center mt-8">
            No saved contacts yet. Add one above to use it on the Send panel.
          </p>
        ) : (
          <div className="rounded-2xl border border-even-ink-100 bg-even-white overflow-hidden shadow-soft">
            <table className="w-full text-left">
              <thead className="text-caption uppercase tracking-wide text-even-ink-500 bg-even-ink-50/40">
                <tr>
                  <th className="px-4 py-2 font-semibold">Name</th>
                  <th className="px-4 py-2 font-semibold">Email</th>
                  <th className="px-4 py-2 font-semibold">Role</th>
                  <th className="px-4 py-2 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="text-body">
                {items.map((r) => (
                  <tr key={r.id} className="border-t border-even-ink-100">
                    <td className="px-4 py-2 text-even-navy-800">{r.name}</td>
                    <td className="px-4 py-2 text-even-ink-700">{r.email}</td>
                    <td className="px-4 py-2">
                      <select
                        value={r.role}
                        onChange={(e) => void onChangeRole(r, e.target.value as Role)}
                        className="text-caption rounded-md border border-even-ink-200 px-2 py-1"
                      >
                        {ROLE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
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
      </div>
    </main>
  );
}
