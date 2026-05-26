import { notFound } from "next/navigation";

/**
 * Doctor PIN entry shell.
 * Sprint 0: renders the layout placeholder; no real auth flow.
 * Sprint 1: numeric pad + lockout escalation per PRD §8.1.1, §4.15.
 *
 * Per PRD §4.14: unknown slugs must return real HTTP 404 indistinguishable
 * from a typo. Sprint 1 wires the doctor lookup that drives notFound().
 */
export default async function DoctorPinEntryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // Sprint 0 placeholder: slug not validated. Sprint 1 looks up by url_slug.
  // For now: render only if slug looks like dr-<word>-<4-char-token>.
  const valid = /^dr-[a-z0-9-]+-[a-z2-9]{4}$/.test(slug);
  if (!valid) notFound();

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <header className="text-center mb-8">
          <h1 className="text-display text-even-navy-800">Even Hospital</h1>
          <p className="mt-1 text-caption text-even-ink-500">
            Encounter Assistant
          </p>
        </header>

        <section
          aria-label="PIN entry"
          className="rounded-xl border border-even-ink-100 bg-even-white p-6 shadow-card"
        >
          <p className="text-label text-even-navy-800 mb-2">Welcome back</p>
          <p className="text-body text-even-ink-700 mb-6">
            Enter your 4-digit PIN
          </p>

          {/* Sprint 0 placeholder dots — Sprint 1 wires the numeric pad */}
          <div className="flex justify-center gap-4 mb-8" aria-live="polite">
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className="block w-3 h-3 rounded-full bg-even-ink-200"
                aria-hidden="true"
              />
            ))}
          </div>

          <p className="text-caption text-even-ink-400 text-center">
            (PIN pad — Sprint 1)
          </p>
        </section>

        <p className="mt-6 text-caption text-even-ink-400 text-center">
          By recording, you confirm patient consent has been obtained per
          your clinic&apos;s policy.
        </p>

        <p className="mt-4 text-caption text-even-ink-500 text-center">
          Forgot PIN? Contact your administrator.
        </p>
      </div>
    </main>
  );
}
