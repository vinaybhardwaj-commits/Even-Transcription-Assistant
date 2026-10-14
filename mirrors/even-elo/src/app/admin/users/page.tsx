"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";
import { ROLE_META } from "@/lib/roles";

interface ProfileRow {
  id: string;
  email: string;
  full_name: string;
  status: string;
  is_super_admin: boolean;
  is_sgc_member: boolean;
  is_hr: boolean;
  is_site_medical_head: boolean;
  position_label: string;
  hospital_code: string;
  last_login_at: string | null;
  created_at: string;
  submitted_count: number;
  retracted_count: number;
}

const STATUS_PILL: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700",
  pending_approval: "bg-amber-50 text-amber-700",
  suspended: "bg-stone-100 text-stone-600",
  rejected: "bg-red-50 text-red-700",
  deactivated: "bg-stone-200 text-stone-500",
};

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

interface HospitalOption { id: string; code: string; }
interface RoleRow { role: string; hospital_code: string; }

export default function UsersPage() {
  const [rows, setRows] = useState<ProfileRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hospitals, setHospitals] = useState<HospitalOption[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [rolesByProfile, setRolesByProfile] = useState<Record<string, Set<string>>>({});
  const [positions, setPositions] = useState<string[]>([]);
  const [addOpen, setAddOpen] = useState(false);

  // load hospitals once (drives the grid columns)
  useEffect(() => {
    fetch("/api/hospitals").then((r) => r.json()).then((j) => {
      if (j.ok) setHospitals(j.hospitals as HospitalOption[]);
    }).catch(() => undefined);
    fetch("/api/positions").then((r) => r.json()).then((j) => {
      if (j.ok) setPositions((j.positions as Array<{ position_name: string }>).map((p) => p.position_name));
    }).catch(() => undefined);
  }, []);

  async function loadRolesFor(profileId: string) {
    const r = await fetch(`/api/admin/profiles/${profileId}/roles`);
    const j = await r.json();
    if (j.ok) {
      const set = new Set<string>();
      for (const row of j.roles as RoleRow[]) set.add(`${row.hospital_code}|${row.role}`);
      setRolesByProfile((prev) => ({ ...prev, [profileId]: set }));
    }
  }

  async function toggleRoleCell(profileId: string, hospital_code: string, role: string, currentlyGranted: boolean) {
    const key = `${hospital_code}|${role}`;
    // Optimistic update
    setRolesByProfile((prev) => {
      const set = new Set(prev[profileId] ?? []);
      if (currentlyGranted) set.delete(key); else set.add(key);
      return { ...prev, [profileId]: set };
    });
    try {
      await fetch(`/api/admin/profiles/${profileId}/roles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hospital_code, role, granted: !currentlyGranted }),
      });
    } catch {
      // revert on failure
      await loadRolesFor(profileId);
    }
    // Refresh the rolled-up aggregated booleans on the directory row
    load();
  }

  function expand(profileId: string) {
    if (expandedId === profileId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(profileId);
    if (!rolesByProfile[profileId]) loadRolesFor(profileId);
  }

  function load() {
    setLoading(true);
    const url = filter ? `/api/admin/profiles?status=${filter}` : "/api/admin/profiles";
    fetch(url)
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) {
          setRows(j.rows ?? []);
          setCounts(j.counts ?? {});
        }
      })
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filter]);

  async function toggleFlag(id: string, key: string, value: boolean) {
    setBusy(id);
    try {
      const r = await fetch(`/api/admin/profiles/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        alert(j.error || "Update failed");
      }
      load();
    } finally {
      setBusy(null);
    }
  }

  async function changeStatus(id: string, status: string) {
    setBusy(id);
    try {
      await fetch(`/api/admin/profiles/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <TopNav />
      <main className="max-w-[1400px] mx-auto px-8 py-8">
        <div className="text-sm text-stone-500 mb-2">
          <Link href="/admin" className="hover:text-stone-900">Admin</Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-900 font-medium">Users</span>
        </div>
        <div className="flex items-end justify-between mb-5">
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight">Users</h1>
            <div className="text-sm text-stone-500 mt-1">
              {Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(" · ") || "—"}
            </div>
          </div>
          <button onClick={() => setAddOpen(true)} className="bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-hover">+ Add user</button>
        </div>

        <div className="flex gap-2 mb-4 text-sm">
          {["", "active", "pending_approval", "suspended", "rejected", "deactivated"].map((s) => (
            <button
              key={s || "all"}
              onClick={() => setFilter(s)}
              className={`px-3 py-1.5 rounded-lg text-[13px] font-medium ${
                filter === s ? "bg-brand text-white" : "bg-white border border-stone-200 text-stone-700 hover:bg-stone-50"
              }`}
            >
              {s ? s.replace("_", " ") : "all"}
              {counts[s] !== undefined && s ? ` (${counts[s]})` : ""}
            </button>
          ))}
        </div>

        <div className="card overflow-hidden bg-white border border-stone-200 rounded-xl">
          <table className="w-full">
            <thead>
              <tr className="text-left text-[11px] font-medium text-stone-500 tracking-wider uppercase border-b border-stone-200 bg-stone-50">
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Position</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Roles</th>
                <th className="px-4 py-3">Reports</th>
                <th className="px-4 py-3">Last login</th>
                <th className="px-4 py-3 w-44">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-sm text-stone-500">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-sm text-stone-500">No users in this filter.</td></tr>
              ) : rows.map((r) => (
              <React.Fragment key={r.id}>
                <tr className="hover:bg-stone-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className={`w-8 h-8 rounded-full inline-flex items-center justify-center text-[11px] font-medium ${colorFor(r.full_name)}`}>
                        {initials(r.full_name)}
                      </span>
                      <div>
                        <Link href={`/admin/users/${r.id}`} className="text-sm font-medium text-stone-900 hover:text-brand hover:underline">{r.full_name}</Link>
                        <div className="text-xs text-stone-500">{r.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-stone-700">{r.position_label} · {r.hospital_code}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${STATUS_PILL[r.status] ?? "bg-stone-100 text-stone-600"}`}>
                      {r.status.replace("_", " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                      <button
                        onClick={() => toggleFlag(r.id, "is_super_admin", !r.is_super_admin)}
                        disabled={busy === r.id}
                        className={`px-2 py-0.5 rounded-full font-medium ${r.is_super_admin ? "bg-teal-100 text-teal-800" : "bg-stone-100 text-stone-500 hover:bg-stone-200"}`}
                        title={ROLE_META.super_admin.desc}
                      >
                        Super
                      </button>
                      {(([["sgc_member", r.is_sgc_member], ["hr", r.is_hr], ["site_medical_head", r.is_site_medical_head]]) as [string, boolean][]).map(([rk, val]) => (
                        <span key={rk} className={`px-2 py-0.5 rounded-full font-medium ${val ? "bg-emerald-50 text-emerald-700" : "bg-stone-100 text-stone-400"}`}
                          title={`${ROLE_META[rk].label} (${ROLE_META[rk].scope}) — ${ROLE_META[rk].desc}`}>
                          {ROLE_META[rk].short}
                        </span>
                      ))}
                      <button
                        onClick={() => expand(r.id)}
                        className={`px-2 py-0.5 rounded-full font-medium border ${expandedId === r.id ? "bg-brand text-white border-brand" : "bg-white text-stone-700 border-stone-200 hover:bg-stone-50"}`}
                        title="Toggle per-hospital role grid"
                      >
                        Roles {expandedId === r.id ? "▴" : "▾"}
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {r.submitted_count > 0 ? (
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${
                        r.retracted_count > 0 ? "bg-amber-50 text-amber-800" : "bg-stone-100 text-stone-700"
                      }`} title={`${r.retracted_count} retracted of ${r.submitted_count} submitted`}>
                        {r.retracted_count}/{r.submitted_count}
                        {r.retracted_count > 0 ? " retracted" : ""}
                      </span>
                    ) : (
                      <span className="text-stone-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-stone-500 num">
                    {r.last_login_at ? new Date(r.last_login_at).toISOString().slice(0, 10) : "never"}
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={r.status}
                      onChange={(e) => changeStatus(r.id, e.target.value)}
                      disabled={busy === r.id}
                      className="px-2 py-1 border border-stone-200 rounded text-xs bg-white"
                    >
                      <option value="active">Active</option>
                      <option value="pending_approval">Pending</option>
                      <option value="suspended">Suspend</option>
                      <option value="rejected">Reject</option>
                      <option value="deactivated">Deactivate</option>
                    </select>
                  </td>
                </tr>
                {expandedId === r.id && (
                  <tr className="bg-stone-50/60 border-b border-stone-200">
                    <td colSpan={7} className="px-4 py-4">
                      <div className="text-[11px] font-medium text-stone-500 uppercase tracking-wider mb-2">Per-hospital roles</div>
                      <div className="overflow-x-auto">
                        <table className="text-[12px]">
                          <thead>
                            <tr className="text-stone-500">
                              <th className="text-left pr-3 py-1 font-medium">Hospital</th>
                              {(["site_medical_head","hr","sgc_member"] as const).map((role) => (
                                <th key={role} className="px-3 py-1 font-medium text-center" title={ROLE_META[role].desc}>{ROLE_META[role].short}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {hospitals.map((h) => (
                              <tr key={h.code} className="border-t border-stone-200/50">
                                <td className="pr-3 py-1.5 font-medium text-stone-700">{h.code}</td>
                                {(["site_medical_head","hr","sgc_member"] as const).map((role) => {
                                  const key = `${h.code}|${role}`;
                                  const on = rolesByProfile[r.id]?.has(key) ?? false;
                                  return (
                                    <td key={role} className="px-3 py-1.5 text-center">
                                      <label className="inline-flex items-center cursor-pointer">
                                        <input
                                          type="checkbox"
                                          checked={on}
                                          onChange={() => toggleRoleCell(r.id, h.code, role, on)}
                                          className="w-4 h-4 accent-teal-600 cursor-pointer"
                                        />
                                      </label>
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="text-[11px] text-stone-400 mt-2">Grants are immediate. Super Admin is network-wide and managed via the pill above.</div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </main>
      {addOpen && (
        <AddUserModal
          hospitals={hospitals}
          positions={positions}
          onClose={() => setAddOpen(false)}
          onCreated={() => { setAddOpen(false); load(); }}
        />
      )}
    </>
  );
}

function genPin(): string { return String(Math.floor(1000 + Math.random() * 9000)); }

function AddUserModal({ hospitals, positions, onClose, onCreated }: { hospitals: HospitalOption[]; positions: string[]; onClose: () => void; onCreated: () => void }) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [position, setPosition] = useState("");
  const [hospital, setHospital] = useState(hospitals[0]?.code ?? "EHRC");
  const [superAdmin, setSuperAdmin] = useState(false);
  const [pin, setPin] = useState(genPin());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emailOk = /@even\.in$/i.test(email.trim());
  const canSubmit = !!fullName.trim() && emailOk && !!position && !!hospital && /^\d{4}$/.test(pin) && !submitting;

  async function submit() {
    setError(null); setSubmitting(true);
    try {
      const r = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ full_name: fullName.trim(), email: email.trim().toLowerCase(), pin, position_name: position, hospital_code: hospital, is_super_admin: superAdmin }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) { setError(j.error || "Create failed"); setSubmitting(false); return; }
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error"); setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold mb-1">Add user</h2>
        <p className="text-xs text-stone-500 mb-4">Creates an active account with a temporary PIN. The user changes it on first login. Assign per-hospital roles afterward from the Roles grid.</p>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Full name</label>
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand" placeholder="Dr. Jane Doe" />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Email</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand" placeholder="jane.doe@even.in" />
            {email.trim() && !emailOk && <div className="text-[11px] text-red-600 mt-1">Must be an @even.in address.</div>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Position</label>
              <select value={position} onChange={(e) => setPosition(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white">
                <option value="">— Choose —</option>
                {positions.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Home hospital</label>
              <select value={hospital} onChange={(e) => setHospital(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white">
                {hospitals.map((h) => <option key={h.code} value={h.code}>{h.code}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Temporary PIN (4 digits)</label>
            <div className="flex items-center gap-2">
              <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))} className="w-28 px-3 py-2 border border-stone-200 rounded-lg text-sm num" />
              <button type="button" onClick={() => setPin(genPin())} className="text-xs text-brand font-medium">Generate</button>
            </div>
            <div className="text-[11px] text-stone-400 mt-1">User must change this on first login.</div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={superAdmin} onChange={(e) => setSuperAdmin(e.target.checked)} className="accent-teal-600" />
            Super Admin (network-wide)
          </label>
          {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="btn-ghost">Cancel</button>
          <button onClick={submit} disabled={!canSubmit} className="bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50 disabled:cursor-not-allowed">
            {submitting ? "Creating…" : "Create user"}
          </button>
        </div>
      </div>
    </div>
  );
}
