"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";

interface Row {
  id: string;
  prospective_email: string;
  prospective_full_name: string;
  prospective_specialty: string | null;
  hospital_code: string;
  hospital_codes?: string[];
  decision: string;
  decision_rationale: string | null;
  stage: string;
  cooldown_override: boolean;
  prescreened_by_email: string;
  prescreened_at: string;
  decided_at: string | null;
  physician_id: string | null;
  years_post_postgraduate: number | null;
  red_flags: string | null;
}

const STAGE_LABEL: Record<string, { label: string; pill: string }> = {
  prescreen:    { label: "Pre-screen",    pill: "bg-stone-100 text-stone-700" },
  observation:  { label: "Observation",   pill: "bg-amber-50 text-amber-800" },
  decision:     { label: "Decision",      pill: "bg-blue-50 text-blue-800" },
  onboarded:    { label: "Onboarded",     pill: "bg-emerald-50 text-emerald-700" },
  rejected:     { label: "Rejected",      pill: "bg-stone-100 text-stone-600" },
  terminated:   { label: "Terminated",    pill: "bg-red-50 text-red-700" },
};

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const AVATAR_COLORS = [
  "bg-teal-100 text-teal-800", "bg-orange-100 text-orange-800", "bg-violet-100 text-violet-800",
  "bg-rose-100 text-rose-800", "bg-lime-100 text-lime-800", "bg-sky-100 text-sky-800",
];
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export default function OnboardingPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"kanban" | "list">("kanban");
  const [showArchive, setShowArchive] = useState(false);

  function load() {
    setLoading(true);
    fetch("/api/vc-onboarding/prescreens")
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) {
          setRows(j.rows ?? []);
          setCounts(j.counts ?? {});
        }
      })
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  const grouped = useMemo(() => {
    const g: Record<string, Row[]> = { prescreen: [], observation: [], decision: [], onboarded: [], rejected: [], terminated: [] };
    for (const r of rows) (g[r.stage] ?? (g[r.stage] = [])).push(r);
    return g;
  }, [rows]);

  const archive = [...grouped.onboarded, ...grouped.rejected, ...grouped.terminated];
  const activeCount = grouped.prescreen.length + grouped.observation.length + grouped.decision.length;

  return (
    <>
      <TopNav />
      <main className="max-w-[1400px] mx-auto px-8 py-8">
        <div className="flex items-end justify-between mb-6">
          <div>
            <div className="flex items-center gap-2 text-xs text-stone-500 mb-2"><span>Physicians</span><span>/</span><span className="text-stone-900 font-medium">Credentialing</span></div>
            <h1 className="text-[22px] font-semibold tracking-tight">Credentialing</h1>
            <div className="text-sm text-stone-500 mt-1">
              {activeCount} active · {Object.entries(counts).map(([k, n]) => `${STAGE_LABEL[k]?.label ?? k}: ${n}`).join(" · ") || "—"}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex bg-white border border-stone-200 rounded-lg p-0.5 text-xs">
              <button onClick={() => setView("kanban")} className={`px-3 py-1 rounded ${view === "kanban" ? "bg-stone-900 text-white" : "text-stone-600"}`}>Kanban</button>
              <button onClick={() => setView("list")} className={`px-3 py-1 rounded ${view === "list" ? "bg-stone-900 text-white" : "text-stone-600"}`}>List</button>
            </div>
            <Link href="/onboarding/new" className="bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-hover">
              + New VC invitation
            </Link>
          </div>
        </div>

        {loading ? (
          <div className="bg-white border border-stone-200 rounded-xl py-12 text-center text-sm text-stone-500">Loading…</div>
        ) : view === "kanban" ? (
          <>
            <div className="grid grid-cols-3 gap-4">
              {(["prescreen", "observation", "decision"] as const).map((stage) => {
                const list = grouped[stage] ?? [];
                const meta = STAGE_LABEL[stage];
                return (
                  <div key={stage} className="bg-stone-50 border border-stone-200 rounded-xl">
                    <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${meta.pill}`}>
                          {meta.label}
                        </span>
                        <span className="text-[11px] text-stone-500 font-medium">{list.length}</span>
                      </div>
                    </div>
                    <div className="p-3 space-y-2 min-h-[120px]">
                      {list.length === 0 ? (
                        <div className="text-center text-xs text-stone-400 py-6 italic">empty</div>
                      ) : list.map((r) => (
                        <Link
                          key={r.id}
                          href={`/onboarding/${r.id}`}
                          className="block bg-white border border-stone-200 rounded-lg p-3 hover:border-stone-400 hover:shadow-sm transition"
                        >
                          <div className="flex items-start gap-2">
                            <span className={`w-7 h-7 rounded-full inline-flex items-center justify-center text-[10px] font-medium flex-shrink-0 ${colorFor(r.prospective_full_name)}`}>
                              {initials(r.prospective_full_name)}
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-stone-900 truncate">{r.prospective_full_name}</div>
                              <div className="text-[11px] text-stone-500 truncate">
                                {r.prospective_specialty ?? "—"} · {((r.hospital_codes && r.hospital_codes.length > 0) ? r.hospital_codes : [r.hospital_code]).join(", ")}
                              </div>
                              <div className="text-[10px] text-stone-400 mt-1.5">
                                {timeAgo(r.prescreened_at)}
                                {r.red_flags ? " · ⚠" : ""}
                                {r.cooldown_override ? " · override" : ""}
                              </div>
                            </div>
                          </div>
                        </Link>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            {archive.length > 0 && (
              <div className="mt-6">
                <button
                  onClick={() => setShowArchive((s) => !s)}
                  className="text-xs text-stone-500 hover:text-stone-900 font-medium"
                >
                  {showArchive ? "▾" : "▸"} Archive ({archive.length})
                </button>
                {showArchive && (
                  <div className="mt-3 grid grid-cols-3 gap-4">
                    {(["onboarded", "rejected", "terminated"] as const).map((stage) => {
                      const list = grouped[stage] ?? [];
                      const meta = STAGE_LABEL[stage];
                      return (
                        <div key={stage} className="bg-white border border-stone-200 rounded-xl">
                          <div className="px-4 py-3 border-b border-stone-100 flex items-center justify-between">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${meta.pill}`}>{meta.label}</span>
                            <span className="text-[11px] text-stone-500 font-medium">{list.length}</span>
                          </div>
                          <div className="p-2 space-y-1.5 max-h-[260px] overflow-y-auto">
                            {list.length === 0 ? (
                              <div className="text-center text-xs text-stone-400 py-4 italic">none</div>
                            ) : list.map((r) => (
                              <Link
                                key={r.id}
                                href={r.physician_id && stage === "onboarded" ? `/physicians/${r.physician_id}` : `/onboarding/${r.id}`}
                                className="block px-2.5 py-1.5 rounded hover:bg-stone-50 text-xs"
                              >
                                <div className="font-medium text-stone-700 truncate">{r.prospective_full_name}</div>
                                <div className="text-stone-400 truncate">
                                  {r.prospective_specialty ?? "—"} · {timeAgo(r.decided_at ?? r.prescreened_at)}
                                </div>
                              </Link>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          // List view
          <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
            {rows.length === 0 ? (
              <div className="py-16 text-center text-sm text-stone-500">
                No VC pipeline entries. <Link href="/onboarding/new" className="text-brand font-medium">Start one →</Link>
              </div>
            ) : (
              <div className="divide-y divide-stone-100">
                {rows.map((r) => {
                  const stage = STAGE_LABEL[r.stage] ?? { label: r.stage, pill: "bg-stone-100 text-stone-700" };
                  return (
                    <Link
                      key={r.id}
                      href={`/onboarding/${r.id}`}
                      className="block px-5 py-4 hover:bg-stone-50"
                    >
                      <div className="flex items-start gap-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${stage.pill}`}>
                          {stage.label}
                        </span>
                        <span className="text-[11px] text-stone-500 px-2 py-0.5 rounded-full bg-stone-50">
                          {((r.hospital_codes && r.hospital_codes.length > 0) ? r.hospital_codes : [r.hospital_code]).join(", ")}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-stone-900">
                            {r.prospective_full_name}
                            {r.prospective_specialty && <span className="font-normal text-stone-500"> · {r.prospective_specialty}</span>}
                          </div>
                          <div className="text-xs text-stone-500 mt-0.5">
                            {r.prospective_email}
                            {r.years_post_postgraduate ? ` · ${r.years_post_postgraduate}y post-PG` : ""}
                          </div>
                          <div className="text-[11px] text-stone-400 mt-1">
                            Pre-screened {timeAgo(r.prescreened_at)} by {r.prescreened_by_email}
                            {r.red_flags ? ` · ⚠ ${r.red_flags.slice(0, 60)}${r.red_flags.length > 60 ? "…" : ""}` : ""}
                            {r.cooldown_override ? " · cooldown overridden" : ""}
                          </div>
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </main>
    </>
  );
}
