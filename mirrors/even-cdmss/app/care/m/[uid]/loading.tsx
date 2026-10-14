/**
 * /care/m/[uid] skeleton — the member record. Static: no data access, no params read.
 */
export default function Loading() {
  return (
    <div className="mx-auto max-w-4xl px-5 py-8" style={{ fontFamily: 'system-ui, sans-serif' }}>
      <div className="h-5 w-52 animate-pulse rounded bg-slate-200" />
      <div className="mt-2 h-3 w-64 animate-pulse rounded bg-slate-100" />
      <div className="mt-7 space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-xl border border-slate-200 bg-slate-50" />
        ))}
      </div>
      <p className="mt-2.5 text-[11.5px] text-slate-400">Loading the member record…</p>
    </div>
  );
}
