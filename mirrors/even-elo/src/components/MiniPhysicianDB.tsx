"use client";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";

type Row = { id: string; full_name: string; primary_specialty: string | null; current_status: string; hospitals_active: string | null };
type Hosp = { code: string; name: string };

export default function MiniPhysicianDB() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hosp, setHosp] = useState("all"); // independent of the global filter (Q-C)
  const [hospitals, setHospitals] = useState<Hosp[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/hospitals").then((r) => r.json()).then((d) => { if (d.ok) setHospitals(d.hospitals); }).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (q.trim()) p.set("q", q.trim());
      p.set("hospital_code", hosp); // always explicit ("all" or a code) → never inherits the global filter
      const r = await fetch(`/api/physicians?${p.toString()}`);
      const d = await r.json();
      setRows(d.ok ? d.rows : []);
    } catch { setRows([]); }
    setLoading(false);
  }, [q, hosp]);

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  return (
    <section className="bg-white border border-stone-200 rounded-xl flex flex-col h-[420px]">
      <div className="px-5 py-3.5 border-b border-stone-100 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold shrink-0">Physician DB</h2>
        <div className="flex items-center gap-2 flex-1 justify-end">
          <input
            value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name…"
            className="px-2.5 py-1.5 text-[13px] border border-stone-200 rounded-lg outline-none focus:border-teal-600 w-40"
          />
          <select
            value={hosp} onChange={(e) => setHosp(e.target.value)}
            className="px-2 py-1.5 text-[13px] border border-stone-200 rounded-lg outline-none focus:border-teal-600 bg-white"
          >
            <option value="all">All hospitals</option>
            {hospitals.map((h) => <option key={h.code} value={h.code}>{h.code}</option>)}
          </select>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto divide-y divide-stone-50">
        {loading ? (
          <div className="px-5 py-10 text-center text-sm text-stone-400">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-stone-500">No physicians match.</div>
        ) : (
          rows.map((r) => (
            <button
              key={r.id}
              onClick={() => router.push(`/physicians/${r.id}`)}
              className="w-full text-left px-5 py-2.5 hover:bg-stone-50 transition flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-stone-800 truncate">{r.full_name}</div>
                <div className="text-[12px] text-stone-500 truncate">{r.primary_specialty ?? "—"}</div>
              </div>
              {r.hospitals_active && (
                <span className="text-[10px] text-stone-400 shrink-0">{r.hospitals_active}</span>
              )}
            </button>
          ))
        )}
      </div>
      <div className="px-5 py-2 border-t border-stone-100 text-[11px] text-stone-400">
        {loading ? "" : `${rows.length} shown`}
      </div>
    </section>
  );
}
