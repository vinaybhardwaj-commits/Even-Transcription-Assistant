"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TopNav } from "@/components/TopNav";
import { AddPhysicianModal } from "@/components/AddPhysicianModal";

interface PhysicianRow {
  id: string;
  full_name: string;
  primary_specialty: string | null;
  registration_number: string | null;
  email: string | null;
  current_status: string;
  date_joined_network: string | null;
  engagements_count: number;
  hospitals_active: string | null;
}

const STATUS_PILL: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700",
  inactive: "bg-stone-100 text-stone-600",
  terminated: "bg-red-50 text-red-700",
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const AVATAR_COLORS = [
  "bg-teal-100 text-teal-800",
  "bg-orange-100 text-orange-800",
  "bg-violet-100 text-violet-800",
  "bg-rose-100 text-rose-800",
  "bg-lime-100 text-lime-800",
  "bg-sky-100 text-sky-800",
];
function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export default function PhysiciansPage() {
  const router = useRouter();
  const [rows, setRows] = useState<PhysicianRow[]>([]);
  const [specialties, setSpecialties] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  function load() {
    setLoading(true);
    const url = new URL("/api/physicians", window.location.origin);
    if (q.trim()) url.searchParams.set("q", q.trim());
    if (specialty) url.searchParams.set("specialty", specialty);
    if (status) url.searchParams.set("status", status);
    fetch(url.toString())
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) {
          setRows(j.rows ?? []);
          setSpecialties(j.specialties ?? []);
        }
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced re-fetch when filters change
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, specialty, status]);

  const totalLabel = useMemo(() => {
    if (loading) return "Loading…";
    return `${rows.length} ${rows.length === 1 ? "physician" : "physicians"}`;
  }, [loading, rows.length]);

  return (
    <>
      <TopNav />
      <main className="max-w-[1400px] mx-auto px-8 py-8">
        <div className="flex items-end justify-between mb-6">
          <div>
            <div className="flex items-center gap-2 text-xs text-stone-500 mb-2"><span>Physicians</span><span>/</span><span className="text-stone-900 font-medium">Roster</span></div>
            <h1 className="text-[22px] font-semibold tracking-tight">Roster</h1>
            <div className="text-sm text-stone-500 mt-1">{totalLabel} in the network database</div>
          </div>
          <button
            onClick={() => setModalOpen(true)}
            className="bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-hover"
          >
            + Add physician
          </button>
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-3 mb-4">
          <input
            type="search"
            placeholder="Search by name, email, registration…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="flex-1 max-w-md px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand"
          />
          <select
            value={specialty}
            onChange={(e) => setSpecialty(e.target.value)}
            className="px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white"
          >
            <option value="">All specialties</option>
            {specialties.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white"
          >
            <option value="">All status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="terminated">Terminated</option>
          </select>
        </div>

        {/* Table */}
        <div className="card overflow-hidden bg-white border border-stone-200 rounded-xl">
          <table className="w-full">
            <thead>
              <tr className="text-left text-[11px] font-medium text-stone-500 tracking-wider uppercase border-b border-stone-200 bg-stone-50">
                <th className="px-4 py-3">Physician</th>
                <th className="px-4 py-3">Specialty</th>
                <th className="px-4 py-3">Registration</th>
                <th className="px-4 py-3">Hospitals</th>
                <th className="px-4 py-3">Joined</th>
                <th className="px-4 py-3 w-28">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-sm text-stone-500">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-16 text-center text-sm text-stone-500">
                  No physicians match these filters. {!q && !specialty && !status && (
                    <span>Click <span className="text-brand font-medium">+ Add physician</span> to start.</span>
                  )}
                </td></tr>
              ) : rows.map((r) => (
                <tr
                  key={r.id}
                  className="hover:bg-stone-50 cursor-pointer"
                  onClick={(e) => {
                    // Skip if the user clicked an <a> inside (let it handle navigation
                    // natively so cmd/ctrl-click still opens in a new tab).
                    const target = e.target as HTMLElement;
                    if (target.closest('a')) return;
                    router.push(`/physicians/${r.id}`);
                  }}
                >
                  <td className="px-4 py-3">
                    <Link href={`/physicians/${r.id}`} className="flex items-center gap-3">
                      <span className={`w-8 h-8 rounded-full inline-flex items-center justify-center text-[11px] font-medium ${colorFor(r.full_name)}`}>
                        {initials(r.full_name)}
                      </span>
                      <div>
                        <div className="text-sm font-medium text-stone-900">{r.full_name}</div>
                        {r.email && <div className="text-xs text-stone-500">{r.email}</div>}
                      </div>
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-sm text-stone-700">{r.primary_specialty ?? "—"}</td>
                  <td className="px-4 py-3 text-sm text-stone-700 num">{r.registration_number ?? "—"}</td>
                  <td className="px-4 py-3 text-sm text-stone-700">{r.hospitals_active ?? <span className="text-stone-400">none</span>}</td>
                  <td className="px-4 py-3 text-sm text-stone-700 num">{r.date_joined_network ? r.date_joined_network.slice(0, 10) : "—"}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${STATUS_PILL[r.current_status] ?? "bg-stone-100 text-stone-600"}`}>
                      {r.current_status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
      {modalOpen && (
        <AddPhysicianModal
          onClose={() => setModalOpen(false)}
          onCreated={() => {
            setModalOpen(false);
            load();
          }}
        />
      )}
    </>
  );
}
