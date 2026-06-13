"use client";

import * as React from "react";
import { Button } from "@/components/ui/Button";

type AdminRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  last_active_at: string | null;
  created_at: string;
};

function fmt(ts: string | null): string {
  if (!ts) return "—";
  try { return new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); } catch { return "—"; }
}

export function AdminsClient({ currentEmail }: { currentEmail: string }) {
  const [admins, setAdmins] = React.useState<AdminRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [listErr, setListErr] = React.useState<string | null>(null);

  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [formErr, setFormErr] = React.useState<string | null>(null);
  const [formOk, setFormOk] = React.useState<string | null>(null);

  // Per-row password reset.
  const [resetFor, setResetFor] = React.useState<string | null>(null);
  const [resetPw, setResetPw] = React.useState("");
  const [resetBusy, setResetBusy] = React.useState(false);
  const [resetMsg, setResetMsg] = React.useState<{ id: string; ok: boolean; text: string } | null>(null);

  const doReset = async (id: string) => {
    setResetBusy(true);
    setResetMsg(null);
    try {
      const res = await fetch(`/api/admin/admins/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: resetPw }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
      setResetMsg({ id, ok: true, text: "Password updated." });
      setResetFor(null);
      setResetPw("");
    } catch (e) {
      setResetMsg({ id, ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setResetBusy(false);
    }
  };

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/admins", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
      setAdmins((j as { admins: AdminRow[] }).admins ?? []);
      setListErr(null);
    } catch (e) {
      setListErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormErr(null);
    setFormOk(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/admins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
      const created = (j as { admin: AdminRow }).admin;
      setFormOk(`${created.name} added — they can now sign in at /admin with the password you set.`);
      setName(""); setEmail(""); setPassword("");
      await load();
    } catch (err) {
      setFormErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls = "w-full rounded-lg border border-even-ink-100 px-3 py-2 text-body text-even-ink-800 focus:outline-none focus:ring-2 focus:ring-even-navy-800/20";

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Add admin */}
      <section className="rounded-2xl border border-even-ink-100 bg-even-white p-5">
        <h2 className="text-heading text-even-navy-800 mb-1">Add an admin</h2>
        <p className="text-caption text-even-ink-500 mb-4">
          New admins get the same (full) access everyone has. They sign in at <code className="font-mono">/admin</code> with the email + password you set here.
        </p>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-caption text-even-ink-600 mb-1">Full name</label>
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Aditya Jain" autoComplete="off" />
            </div>
            <div>
              <label className="block text-caption text-even-ink-600 mb-1">Email</label>
              <input className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="adi.jain@even.in" type="email" autoComplete="off" />
            </div>
          </div>
          <div>
            <label className="block text-caption text-even-ink-600 mb-1">Password</label>
            <input className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="At least 8 characters" autoComplete="new-password" />
            <p className="mt-1 text-[11px] text-even-ink-400">
              You type this — it is hashed (bcrypt) before storage and never logged. The admin can change it later via Change Password.
            </p>
          </div>
          {formErr ? <p className="text-caption text-danger-700">Couldn’t add admin: {formErr}</p> : null}
          {formOk ? <p className="text-caption text-success-700">{formOk}</p> : null}
          <Button type="submit" disabled={submitting || !name || !email || password.length < 8}>
            {submitting ? "Adding…" : "Add admin"}
          </Button>
        </form>
      </section>

      {/* Current admins */}
      <section className="rounded-2xl border border-even-ink-100 bg-even-white p-5">
        <h2 className="text-heading text-even-navy-800 mb-3">Current admins {admins.length ? `(${admins.length})` : ""}</h2>
        {loading ? (
          <p className="text-body text-even-ink-400">Loading…</p>
        ) : listErr ? (
          <p className="text-body text-danger-700">Couldn’t load admins: {listErr}</p>
        ) : admins.length === 0 ? (
          <p className="text-body text-even-ink-400">No admins yet.</p>
        ) : (
          <div className="divide-y divide-even-ink-100">
            {admins.map((a) => (
              <div key={a.id} className="py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-body text-even-ink-800">
                      {a.name}
                      {a.email.toLowerCase() === currentEmail.toLowerCase() ? <span className="ml-2 text-[11px] text-even-ink-400">(you)</span> : null}
                    </p>
                    <p className="text-caption text-even-ink-500">{a.email}</p>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <p className="text-caption text-even-ink-600 capitalize">{a.role}</p>
                      <p className="text-[11px] text-even-ink-400">last active {fmt(a.last_active_at)}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => { setResetFor(resetFor === a.id ? null : a.id); setResetPw(""); setResetMsg(null); }}
                      className="text-caption text-even-blue-600 hover:text-even-blue-700 hover:underline whitespace-nowrap"
                    >
                      Reset password
                    </button>
                  </div>
                </div>
                {resetFor === a.id ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      className="rounded-lg border border-even-ink-100 px-3 py-1.5 text-body text-even-ink-800 focus:outline-none focus:ring-2 focus:ring-even-navy-800/20"
                      type="password"
                      value={resetPw}
                      onChange={(e) => setResetPw(e.target.value)}
                      placeholder="New password (min 8)"
                      autoComplete="new-password"
                    />
                    <Button size="sm" onClick={() => doReset(a.id)} disabled={resetBusy || resetPw.length < 8}>
                      {resetBusy ? "Saving…" : "Save"}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => { setResetFor(null); setResetPw(""); }}>Cancel</Button>
                  </div>
                ) : null}
                {resetMsg && resetMsg.id === a.id ? (
                  <p className={`mt-1 text-caption ${resetMsg.ok ? "text-success-700" : "text-danger-700"}`}>{resetMsg.text}</p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
