/**
 * /care/briefs skeleton — mirrors the real page's chrome (title + badge, search box, flagged list)
 * so the layout does not jump when the server component resolves. Static: no data access.
 */
export default function Loading() {
  return (
    <div className="mx-auto max-w-4xl px-5 py-8" style={{ fontFamily: 'system-ui, sans-serif' }}>
      <div className="flex items-center gap-2">
        <h1 className="text-[20px] font-semibold text-slate-900">Care Conversation Brief</h1>
        <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[11px] text-teal-700">Advisory · care management</span>
      </div>
      <p className="text-[12.5px] text-slate-500">Look up a member to prep a call, or work today’s flagged list.</p>

      <div className="mt-4 h-10 animate-pulse rounded-lg border border-slate-200 bg-slate-50" />

      <div className="mt-7 flex items-center justify-between">
        <h2 className="text-[12px] font-medium uppercase tracking-wide text-slate-400">Flagged for a conversation</h2>
      </div>

      <div className="mt-2 overflow-hidden rounded-xl border border-slate-200 bg-white">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3 border-t border-slate-100 px-3.5 py-3 first:border-t-0">
            <div className="w-40 shrink-0 space-y-1.5">
              <div className="h-3.5 w-28 animate-pulse rounded bg-slate-200" />
              <div className="h-3 w-20 animate-pulse rounded bg-slate-100" />
            </div>
            <div className="h-3.5 min-w-0 flex-1 animate-pulse rounded bg-slate-100" />
            <div className="h-3.5 w-10 shrink-0 animate-pulse rounded bg-slate-100" />
          </div>
        ))}
      </div>
      <p className="mt-2.5 text-[11.5px] text-slate-400">Loading today’s flagged list…</p>
    </div>
  );
}
