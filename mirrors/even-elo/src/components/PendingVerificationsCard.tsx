"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface PendingQual {
  id: string;
  physician_id: string;
  physician_name: string;
  primary_specialty: string | null;
  degree: string;
  year_completed: number | null;
  institution: string | null;
  country: string | null;
  has_file: boolean;
  filename: string | null;
  created_at: string;
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Broadcast the authoritative live count so the home "Pending credentials" KPI
// (a separate component) stays in sync — on first load and after every verify —
// instead of showing the stale server-rendered count.
function broadcastCount(count: number) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("epi:pending-count", { detail: { count } }));
  }
}

export default function PendingVerificationsCard({ canVerify }: { canVerify: boolean }) {
  const [rows, setRows] = useState<PendingQual[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/qualifications/pending")
      .then((r) => r.json())
      .then((j) => { if (j.ok) { const list = (j.rows ?? []) as PendingQual[]; setRows(list); broadcastCount(list.length); } })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  async function verify(q: PendingQual) {
    setErr(null);
    setBusy(q.id);
    try {
      const r = await fetch(`/api/physicians/${q.physician_id}/qualifications/${q.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verified: true }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) { setErr(j.error || "Verify failed."); setBusy(null); return; }
      setRows((prev) => { const next = prev.filter((x) => x.id !== q.id); broadcastCount(next.length); return next; });
      setBusy(null);
    } catch { setErr("Network error."); setBusy(null); }
  }

  return (
    <section className="bg-white border border-stone-200 rounded-xl flex flex-col h-[300px]">
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-stone-100 shrink-0">
        <h2 className="text-sm font-semibold">Credentials pending verification</h2>
        <span className={`text-[11px] rounded-full px-2 py-0.5 font-medium ${rows.length > 0 ? "bg-amber-50 text-amber-800" : "bg-stone-100 text-stone-600"}`}>{rows.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {!loaded ? (
          <div className="px-5 py-8 text-center text-sm text-stone-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-stone-500">Nothing awaiting verification.</div>
        ) : (
          <div className="divide-y divide-stone-100">
            {rows.map((q) => (
              <div key={q.id} className="px-5 py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    <Link href={`/physicians/${q.physician_id}`} className="hover:underline">{q.physician_name}</Link>
                    <span className="text-stone-400 font-normal"> · {q.degree}{q.year_completed ? ` (${q.year_completed})` : ""}</span>
                  </div>
                  <div className="text-[12px] text-stone-500 truncate">
                    {q.institution ?? "—"}{q.country ? ` · ${q.country}` : ""}{q.primary_specialty ? ` · ${q.primary_specialty}` : ""} · {timeAgo(q.created_at)}
                  </div>
                </div>
                {q.has_file ? (
                  <a
                    href={`/api/physicians/${q.physician_id}/qualifications/${q.id}/file`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[12px] text-brand font-medium hover:underline shrink-0"
                  >
                    View
                  </a>
                ) : (
                  <span className="text-[11px] text-stone-400 shrink-0">no file</span>
                )}
                {canVerify && (
                  <button
                    onClick={() => verify(q)}
                    disabled={busy === q.id}
                    className="px-3 py-1 rounded-lg text-[12px] font-medium bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 shrink-0"
                  >
                    {busy === q.id ? "…" : "Verify"}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {err && <div className="px-5 py-2 text-[12px] text-red-700 bg-red-50 border-t border-red-100 shrink-0">{err}</div>}
    </section>
  );
}
