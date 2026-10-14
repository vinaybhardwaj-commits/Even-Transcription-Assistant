"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Row = {
  id: string;
  target_physician_name: string;
  polarity: string;
  category: string | null;
  severity: string | null;
  commendation_category: string | null;
  submitted_at: string;
};

const CATEGORIES: Record<string, string> = {
  clinical: "Clinical", patient_safety: "Patient safety", medical_error: "Medical error",
  professionalism: "Professionalism", documentation: "Documentation", etiquette: "Etiquette",
  vendor_compliance: "Vendor compliance", other: "Other",
};

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (!t) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/**
 * Home-dashboard feedback inbox — browsable, filterable (mirrors the main
 * /incidents module's filters). Fetches open feedback from /api/incidents with
 * the chosen filters so the per-filter view isn't capped to a positives-heavy slice.
 */
export default function InboxCard({ openCount, positiveCount }: { openCount: number; positiveCount: number }) {
  const [polarity, setPolarity] = useState("");
  const [severity, setSeverity] = useState("");
  const [category, setCategory] = useState("");
  const [src, setSrc] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const u = new URL("/api/incidents", window.location.origin);
    u.searchParams.set("status", "open");
    if (polarity) u.searchParams.set("polarity", polarity);
    if (severity) u.searchParams.set("severity", severity);
    if (category) u.searchParams.set("category", category);
    if (src) u.searchParams.set("source", src);
    u.searchParams.set("limit", "200");
    fetch(u.toString())
      .then((r) => r.json())
      .then((j) => { if (j.ok) setRows(j.rows ?? []); })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [polarity, severity, category, src]);

  const sel = "px-2 py-1 border border-stone-200 rounded-md text-[12px] bg-white";

  return (
    <section className="bg-white border border-stone-200 rounded-xl flex flex-col h-[300px]">
      <div className="flex items-center justify-between px-5 py-3 border-b border-stone-100 shrink-0">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Inbox</h2>
          <span className="text-[11px] bg-stone-100 text-stone-600 rounded-full px-2 py-0.5 font-medium">{openCount}</span>
          {positiveCount > 0 && <span className="text-[11px] text-emerald-600 font-medium">+{positiveCount} positive</span>}
          {!loading && <span className="text-[11px] text-stone-400">· {rows.length} shown</span>}
        </div>
        <Link href="/incidents" className="text-[12px] text-brand font-medium">Open inbox →</Link>
      </div>
      <div className="flex items-center gap-1.5 px-4 py-2 border-b border-stone-100 shrink-0 flex-wrap">
        <select value={polarity} onChange={(e) => setPolarity(e.target.value)} className={sel}>
          <option value="">All feedback</option>
          <option value="negative">Concerns</option>
          <option value="positive">Positive</option>
        </select>
        <select value={severity} onChange={(e) => setSeverity(e.target.value)} className={sel}>
          <option value="">All severities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} className={sel}>
          <option value="">All categories</option>
          {Object.entries(CATEGORIES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select value={src} onChange={(e) => setSrc(e.target.value)} className={sel}>
          <option value="">All sources</option>
          <option value="patient">Patient</option>
          <option value="peer">Peer</option>
          <option value="governance">Governance</option>
        </select>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="px-5 py-10 text-center text-sm text-stone-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-stone-500">No feedback matches these filters.</div>
        ) : (
          <div className="divide-y divide-stone-50">
            {rows.map((r) => {
              const isPos = r.polarity === "positive";
              const label = isPos
                ? (r.commendation_category ?? "Positive feedback")
                : (r.category ? (CATEGORIES[r.category] ?? r.category) : "Concern");
              return (
                <Link key={r.id} href={`/incidents/${r.id}`} className="flex items-center justify-between px-5 py-2.5 hover:bg-stone-50 transition">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={`inline-flex shrink-0 items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${isPos ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{isPos ? "Positive" : "Concern"}</span>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-stone-800 truncate">{r.target_physician_name}</div>
                      <div className="text-[12px] text-stone-500 truncate">{label}{!isPos && r.severity ? ` · ${r.severity}` : ""}</div>
                    </div>
                  </div>
                  <span className="text-[11px] text-stone-400 shrink-0 ml-3">{timeAgo(r.submitted_at)}</span>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
