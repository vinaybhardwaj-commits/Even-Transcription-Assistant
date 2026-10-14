/**
 * Route-segment skeleton for the whole /care subtree. Static server component: no data access,
 * no client JS beyond the CSS animation. Exists so a slow render shows structure instead of a
 * blank tab (the symptom V reported on /care/briefs).
 */
export default function Loading() {
  return (
    <div className="mx-auto max-w-4xl px-5 py-8" style={{ fontFamily: 'system-ui, sans-serif' }}>
      <div className="h-5 w-64 animate-pulse rounded bg-slate-200" />
      <div className="mt-2 h-3 w-80 animate-pulse rounded bg-slate-100" />
      <div className="mt-7 space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-12 animate-pulse rounded-xl border border-slate-200 bg-slate-50" />
        ))}
      </div>
    </div>
  );
}
