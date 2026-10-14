"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Spec = { specialty: string; vc: number; staff: number; total: number };
type Hosp = { code: string; name: string; vc: number; staff: number; total: number; specialties: Spec[] };
type Member = { id: string; full_name: string; primary_specialty: string | null; category: string };

export default function CensusCards({ byHospital }: { byHospital: Hosp[] }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(byHospital.length === 1 ? [byHospital[0].code] : []));
  const [drawer, setDrawer] = useState<{ title: string; members: Member[]; loading: boolean } | null>(null);

  function toggle(code: string) {
    setExpanded((p) => { const n = new Set(p); if (n.has(code)) n.delete(code); else n.add(code); return n; });
  }
  async function open(title: string, params: Record<string, string>) {
    setDrawer({ title, members: [], loading: true });
    try {
      const r = await fetch(`/api/admin/census/members?${new URLSearchParams(params).toString()}`);
      const d = await r.json();
      setDrawer({ title, members: d.ok ? d.members : [], loading: false });
    } catch { setDrawer({ title, members: [], loading: false }); }
  }
  const Num = ({ children, onClick, cls = "" }: { children: React.ReactNode; onClick: () => void; cls?: string }) => (
    <button onClick={(e) => { e.stopPropagation(); onClick(); }} className={`tabular-nums hover:underline decoration-dotted underline-offset-2 ${cls}`}>{children}</button>
  );

  return (
    <section className="bg-white border border-stone-200 rounded-xl flex flex-col h-[440px]">
      <div className="px-5 py-3.5 border-b border-stone-100 shrink-0">
        <h2 className="text-sm font-semibold">Census</h2>
        <p className="text-[11px] text-stone-400 mt-0.5">By active engagement · expand a hospital, click any number for names</p>
      </div>
      <div className="flex-1 overflow-y-auto">
        {byHospital.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-stone-500">No active engagements.</div>
        ) : byHospital.map((h) => {
          const isOpen = expanded.has(h.code);
          return (
            <div key={h.code} className="border-b border-stone-100 last:border-0">
              <button onClick={() => toggle(h.code)} className="w-full px-4 py-3 flex items-center justify-between gap-3 hover:bg-stone-50 transition text-left">
                <span className="flex items-center gap-2 min-w-0">
                  <span className={`text-stone-400 text-xs transition-transform ${isOpen ? "rotate-90" : ""}`}>▸</span>
                  <span className="min-w-0">
                    <span className="text-sm font-medium text-stone-800">{h.code}</span>
                    <span className="text-[12px] text-stone-500 ml-2 truncate">{h.name}</span>
                  </span>
                </span>
                <span className="shrink-0 text-[12px] flex items-center gap-2">
                  <Num cls="text-violet-700" onClick={() => open(`${h.code} · VC`, { group: "hospital", hospital_code: h.code, bucket: "vc" })}>{h.vc} VC</Num>
                  <span className="text-stone-300">·</span>
                  <Num cls="text-stone-600" onClick={() => open(`${h.code} · Staff`, { group: "hospital", hospital_code: h.code, bucket: "staff" })}>{h.staff} Staff</Num>
                  <span className="text-stone-300">·</span>
                  <Num cls="font-semibold text-stone-900" onClick={() => open(`${h.code} · All`, { group: "hospital", hospital_code: h.code })}>{h.total}</Num>
                </span>
              </button>
              {isOpen && (
                <div className="px-4 pb-3 pl-9">
                  {h.specialties.length === 0 ? (
                    <div className="text-[12px] text-stone-400 py-1">No specialties.</div>
                  ) : h.specialties.map((s) => (
                    <button
                      key={s.specialty}
                      onClick={() => open(`${h.code} · ${s.specialty}`, { group: "specialty", specialty: s.specialty, hospital_code: h.code })}
                      className="w-full flex items-center justify-between py-1 px-1 -mx-1 rounded hover:bg-stone-50 transition text-left"
                    >
                      <span className="text-[13px] text-stone-600 truncate">{s.specialty}</span>
                      <span className="shrink-0 text-right">
                        <span className="text-[13px] font-semibold text-stone-800 tabular-nums">{s.total}</span>
                        <span className="text-[11px] text-stone-400 ml-1.5">{s.vc} VC · {s.staff} Staff</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {drawer && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/30" onClick={() => setDrawer(null)} />
          <div className="absolute right-0 top-0 h-full w-full max-w-sm bg-white shadow-2xl flex flex-col">
            <div className="px-5 py-4 border-b border-stone-100 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold">{drawer.title}</h3>
                <p className="text-[11px] text-stone-400">{drawer.loading ? "Loading…" : `${drawer.members.length} ${drawer.members.length === 1 ? "doctor" : "doctors"}`}</p>
              </div>
              <button onClick={() => setDrawer(null)} className="text-stone-400 hover:text-stone-700 text-xl leading-none">×</button>
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-stone-50">
              {!drawer.loading && drawer.members.length === 0 && (
                <div className="px-5 py-10 text-center text-sm text-stone-500">No doctors in this group.</div>
              )}
              {drawer.members.map((m) => (
                <button key={m.id} onClick={() => router.push(`/physicians/${m.id}`)} className="w-full text-left px-5 py-2.5 hover:bg-stone-50 transition flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-stone-800 truncate">{m.full_name}</div>
                    <div className="text-[12px] text-stone-500 truncate">{m.primary_specialty ?? "—"}</div>
                  </div>
                  <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${m.category === "VC" ? "bg-violet-50 text-violet-700" : "bg-stone-100 text-stone-600"}`}>{m.category}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
