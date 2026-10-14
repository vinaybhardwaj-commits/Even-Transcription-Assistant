"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";

interface RequestedRole { hospital_code: string; role: string; }
interface ProfileRow {
  id: string;
  email: string;
  full_name: string;
  status: string;
  position_label: string;
  hospital_code: string;
  created_at: string;
  requested_roles?: RequestedRole[];
}

const ROLE_LABEL: Record<string, string> = {
  site_medical_head: "Site MH",
  hr: "HR",
  sgc_member: "SGC",
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

export default function PendingPage() {
  const [rows, setRows] = useState<ProfileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  function load() {
    setLoading(true);
    fetch("/api/admin/profiles?status=pending_approval")
      .then((r) => r.json())
      .then((j) => j.ok && setRows(j.rows ?? []))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  // Per-row accepted-role overrides (key = profile.id, value = subset of requested_roles)
  const [accepted, setAccepted] = useState<Record<string, RequestedRole[]>>({});

  function toggleAccept(profileId: string, role: RequestedRole) {
    setAccepted((prev) => {
      const cur = prev[profileId] ?? rows.find((r) => r.id === profileId)?.requested_roles ?? [];
      const key = `${role.hospital_code}|${role.role}`;
      const hit = cur.find((x) => `${x.hospital_code}|${x.role}` === key);
      const next = hit ? cur.filter((x) => `${x.hospital_code}|${x.role}` !== key) : [...cur, role];
      return { ...prev, [profileId]: next };
    });
  }

  function isAccepted(profileId: string, role: RequestedRole): boolean {
    const cur = accepted[profileId] ?? rows.find((r) => r.id === profileId)?.requested_roles ?? [];
    return !!cur.find((x) => x.hospital_code === role.hospital_code && x.role === role.role);
  }

  async function act(id: string, status: "active" | "rejected") {
    setBusy(id);
    try {
      const body: Record<string, unknown> = { status };
      if (status === "active") {
        // Default to the full requested set if admin didn't override
        const requestedDefault = rows.find((r) => r.id === id)?.requested_roles ?? [];
        body.accepted_roles_override = accepted[id] ?? requestedDefault;
      }
      await fetch(`/api/admin/profiles/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <TopNav />
      <main className="max-w-[1100px] mx-auto px-8 py-8">
        <div className="text-sm text-stone-500 mb-2">
          <Link href="/admin" className="hover:text-stone-900">Admin</Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-900 font-medium">Pending approvals</span>
        </div>
        <div className="flex items-end justify-between mb-6">
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight">Pending approvals</h1>
            <div className="text-sm text-stone-500 mt-1">
              {loading ? "Loading…" : `${rows.length} ${rows.length === 1 ? "request" : "requests"} awaiting review`}
            </div>
          </div>
        </div>

        {loading ? (
          <div className="bg-white border border-stone-200 rounded-xl py-12 text-center text-sm text-stone-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="bg-white border border-stone-200 rounded-xl py-16 text-center">
            <div className="text-3xl mb-2">✓</div>
            <div className="text-sm text-stone-700 font-medium">All caught up</div>
            <div className="text-sm text-stone-500 mt-1">No pending approvals right now.</div>
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => (
              <div key={r.id} className="bg-white border border-stone-200 rounded-xl px-5 py-4 flex items-center gap-4">
                <span className={`w-10 h-10 rounded-full inline-flex items-center justify-center text-[12px] font-medium ${colorFor(r.full_name)}`}>
                  {initials(r.full_name)}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-stone-900">{r.full_name}</div>
                  <div className="text-xs text-stone-500">{r.email}</div>
                  <div className="text-xs text-stone-500 mt-0.5">
                    {r.position_label} · {r.hospital_code} · requested {timeAgo(r.created_at)}
                  </div>
                  {(r.requested_roles ?? []).length > 0 && (
                    <div className="mt-2">
                      <div className="text-[11px] font-medium text-stone-500 uppercase tracking-wider mb-1">Requested roles</div>
                      <div className="flex flex-wrap gap-1.5">
                        {(r.requested_roles ?? []).map((rr) => {
                          const on = isAccepted(r.id, rr);
                          return (
                            <button
                              key={`${rr.hospital_code}|${rr.role}`}
                              type="button"
                              onClick={() => toggleAccept(r.id, rr)}
                              className={`px-2 py-0.5 rounded-full text-[11px] font-medium border ${on ? "bg-teal-100 text-teal-800 border-teal-200" : "bg-white text-stone-500 border-stone-200 line-through hover:bg-stone-50"}`}
                              title={on ? "Click to strip this role from approval" : "Click to accept this role"}
                            >
                              {rr.hospital_code} · {ROLE_LABEL[rr.role] ?? rr.role}
                            </button>
                          );
                        })}
                      </div>
                      <div className="text-[10px] text-stone-400 mt-1">Strike-through = will not be granted. Click to toggle.</div>
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => act(r.id, "rejected")}
                    disabled={busy === r.id}
                    className="px-3 py-1.5 rounded-lg text-sm font-medium text-red-700 bg-red-50 hover:bg-red-100 disabled:opacity-60"
                  >
                    Reject
                  </button>
                  <button
                    onClick={() => act(r.id, "active")}
                    disabled={busy === r.id}
                    className="px-4 py-1.5 rounded-lg text-sm font-medium bg-brand text-white hover:bg-brand-hover disabled:opacity-60"
                  >
                    {busy === r.id ? "Working…" : "Approve"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
