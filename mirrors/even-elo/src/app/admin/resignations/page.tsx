"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";

interface Row { id: string; physician_id: string; physician_name: string; reason: string; intended_last_date: string | null; status: string; requested_at: string; hospital_code: string | null }

export default function ResignationsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  function load() { setLoading(true); fetch("/api/admin/resignations").then((r) => r.json()).then((j) => { if (j.ok) setRows(j.rows ?? []); }).finally(() => setLoading(false)); }
  useEffect(() => { load(); }, []);

  async function process(id: string, name: string) {
    if (!confirm(`Process ${name}'s resignation? This sets the engagement(s) to 'resigned'.`)) return;
    setBusy(id);
    try { const r = await fetch(`/api/admin/resignations/${id}/process`, { method: "POST" }); const j = await r.json(); if (!r.ok || !j.ok) alert(j.error || "Failed"); load(); } finally { setBusy(null); }
  }

  return (
    <>
      <TopNav />
      <main className="max-w-[1000px] mx-auto px-8 py-8">
        <div className="text-sm text-stone-500 mb-2"><Link href="/admin" className="hover:text-stone-900">Admin</Link><span className="mx-1.5">/</span><span className="text-stone-900 font-medium">Resignations</span></div>
        <h1 className="text-[22px] font-semibold tracking-tight mb-5">Resignation requests</h1>
        <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
          {loading ? <div className="py-12 text-center text-sm text-stone-500">Loading…</div> : rows.length === 0 ? <div className="py-12 text-center text-sm text-stone-500">No resignation requests.</div> : (
            <div className="divide-y divide-stone-100">
              {rows.map((r) => (
                <div key={r.id} className="px-5 py-4 flex items-start gap-4">
                  <div className="flex-1">
                    <div className="text-sm font-medium">{r.physician_name} <span className="text-stone-400 font-normal">· {r.hospital_code ?? "all hospitals"}</span></div>
                    <div className="text-xs text-stone-600 mt-0.5">{r.reason}</div>
                    <div className="text-[11px] text-stone-400 mt-1">requested {new Date(r.requested_at).toISOString().slice(0, 10)}{r.intended_last_date ? ` · last day ${r.intended_last_date.slice(0, 10)}` : ""}</div>
                  </div>
                  {r.status === "pending" ? (
                    <button onClick={() => process(r.id, r.physician_name)} disabled={busy === r.id} className="px-3 py-2 rounded-lg text-sm font-medium text-stone-700 bg-stone-100 hover:bg-stone-200 disabled:opacity-50">Process</button>
                  ) : (
                    <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-stone-100 text-stone-500 self-center">{r.status}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
