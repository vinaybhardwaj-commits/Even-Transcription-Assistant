/**
 * Admin token entry shell.
 *
 * Sprint 0: lives at /admin (fixed path) so the route renders.
 * Sprint 3: moves to /{ADMIN_BASE_PATH}/ via Next.js middleware that
 *   rewrites the runtime-generated obscure path to the private _admin
 *   route. PRD §4.16 — probe-proof unknown URLs must return real 404.
 */
export default function AdminLoginShell() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6 bg-even-ink-50">
      <div className="w-full max-w-md">
        <header className="text-center mb-8">
          <h1 className="text-display text-even-navy-800">
            Even Encounter Assistant
          </h1>
          <p className="mt-1 text-caption text-even-ink-500">Admin</p>
        </header>

        <section
          aria-label="Admin sign-in"
          className="rounded-xl border border-even-ink-100 bg-even-white p-8 shadow-card"
        >
          <label className="block text-label text-even-navy-800 mb-2" htmlFor="admin-token">
            Admin token
          </label>
          <input
            id="admin-token"
            type="password"
            autoComplete="off"
            disabled
            className="block w-full px-3 py-2 rounded-md border border-even-ink-200 text-body text-even-ink-500 bg-even-ink-50"
            placeholder="(Sprint 3 wires auth)"
          />
          <button
            type="button"
            disabled
            className="mt-4 block w-full py-2 rounded-md bg-even-ink-200 text-even-ink-500 text-label font-medium cursor-not-allowed"
          >
            Sign in
          </button>
        </section>

        <p className="mt-4 text-caption text-even-ink-400 text-center">
          Restricted access. Auth wired in Sprint 3.
        </p>
      </div>
    </main>
  );
}
