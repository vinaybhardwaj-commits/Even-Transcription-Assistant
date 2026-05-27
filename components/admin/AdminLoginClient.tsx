"use client";

import * as React from "react";

export function AdminLoginClient() {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const onSubmit = React.useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!email || !password) return;
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch("/api/admin/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const j = await res.json();
        if (!res.ok) {
          const msg = (j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`;
          setError(msg);
          setSubmitting(false);
          return;
        }
        // Cookie set server-side; reload to pick it up.
        window.location.reload();
      } catch (e2) {
        setError(e2 instanceof Error ? e2.message : String(e2));
        setSubmitting(false);
      }
    },
    [email, password],
  );

  return (
    <main className="min-h-screen flex items-center justify-center px-6 bg-even-ink-50">
      <form onSubmit={onSubmit} className="w-full max-w-md">
        <header className="text-center mb-8">
          <h1 className="text-display text-even-navy-800">Even Encounter Assistant</h1>
          <p className="mt-1 text-caption text-even-ink-500">Admin</p>
        </header>
        <section
          aria-label="Admin sign-in"
          className="rounded-xl border border-even-ink-100 bg-even-white p-8 shadow-card space-y-4"
        >
          <div>
            <label className="block text-label text-even-navy-800 mb-1" htmlFor="admin-email">
              Email
            </label>
            <input
              id="admin-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="block w-full px-3 py-2 rounded-md border border-even-ink-200 text-body focus:outline-none focus:ring-2 focus:ring-even-blue-300"
            />
          </div>
          <div>
            <label className="block text-label text-even-navy-800 mb-1" htmlFor="admin-pw">
              Password
            </label>
            <input
              id="admin-pw"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={4}
              className="block w-full px-3 py-2 rounded-md border border-even-ink-200 text-body focus:outline-none focus:ring-2 focus:ring-even-blue-300"
            />
          </div>
          {error ? <p className="text-caption text-danger-700">{error}</p> : null}
          <button
            type="submit"
            disabled={submitting}
            className="mt-2 block w-full py-2 rounded-md bg-even-blue-600 hover:bg-even-blue-700 disabled:bg-even-blue-300 text-white text-label font-medium transition"
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </section>
        <p className="mt-4 text-caption text-even-ink-400 text-center">Restricted access.</p>
      </form>
    </main>
  );
}
