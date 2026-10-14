"use client";

import React, { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";
import { ROLE_META } from "@/lib/roles";

interface Profile {
  id: string;
  email: string;
  full_name: string;
  status: string;
  is_super_admin: boolean;
  is_sgc_member: boolean;
  is_hr: boolean;
  is_site_medical_head: boolean;
  position_id: string;
  position_label: string;
  hospital_id: string | null;
  hospital_code: string | null;
  hospital_name: string | null;
  last_login_at: string | null;
  created_at: string;
  must_change_pin?: boolean;
}
interface RoleRow { role: string; hospital_code: string }
interface AuditRow { id: number; action: string; entity_type: string; created_at: string; actor_email: string | null }
interface HospitalOption { id: string; code: string }

const STATUS_PILL: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700",
  pending_approval: "bg-amber-50 text-amber-700",
  suspended: "bg-stone-100 text-stone-600",
  rejected: "bg-red-50 text-red-700",
  deactivated: "bg-stone-200 text-stone-500",
};
const AVATAR_COLORS = ["bg-teal-100 text-teal-800","bg-orange-100 text-orange-800","bg-violet-100 text-violet-800","bg-rose-100 text-rose-800","bg-lime-100 text-lime-800","bg-sky-100 text-sky-800"];
function initials(name: string): string { const p = name.trim().split(/\s+/).filter(Boolean); if (!p.length) return "?"; if (p.length === 1) return p[0].slice(0,2).toUpperCase(); return (p[0][0]+p[p.length-1][0]).toUpperCase(); }
function colorFor(name: string): string { let h=0; for (let i=0;i<name.length;i++) h=(h*31+name.charCodeAt(i))&0xffff; return AVATAR_COLORS[h%AVATAR_COLORS.length]; }
function timeAgo(iso: string): string { const s=Math.max(1,Math.floor((Date.now()-new Date(iso).getTime())/1000)); if(s<60)return `${s}s ago`; if(s<3600)return `${Math.floor(s/60)}m ago`; if(s<86400)return `${Math.floor(s/3600)}h ago`; return `${Math.floor(s/86400)}d ago`; }

const ROLE_COLS: string[] = ["site_medical_head", "hr", "sgc_member"];

export default function UserDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [profile, setProfile] = useState<Profile | null>(null);
  const [roles, setRoles] = useState<Set<string>>(new Set());
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [hospitals, setHospitals] = useState<HospitalOption[]>([]);
  const [positions, setPositions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetResult, setResetResult] = useState<string | null>(null);

  // identity edit state
  const [fullName, setFullName] = useState("");
  const [position, setPosition] = useState("");
  const [hospital, setHospital] = useState("");

  function load() {
    if (!id) return;
    setLoading(true);
    Promise.all([
      fetch(`/api/admin/profiles/${id}`).then((r) => r.json()),
      fetch(`/api/hospitals`).then((r) => r.json()),
      fetch(`/api/positions`).then((r) => r.json()),
    ]).then(([pj, hj, posj]) => {
      if (!pj.ok) { setErr(pj.error || "Not found"); return; }
      const p = pj.profile as Profile;
      setProfile(p);
      setFullName(p.full_name);
      setPosition(p.position_label);
      setHospital(p.hospital_code ?? "");
      const set = new Set<string>();
      for (const r of (pj.roles as RoleRow[]) ?? []) set.add(`${r.hospital_code}|${r.role}`);
      setRoles(set);
      setAudit((pj.audit as AuditRow[]) ?? []);
      if (hj.ok) setHospitals(hj.hospitals as HospitalOption[]);
      if (posj.ok) setPositions((posj.positions as Array<{ position_name: string }>).map((x) => x.position_name));
    }).catch((e) => setErr(e instanceof Error ? e.message : String(e))).finally(() => setLoading(false));
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  async function patch(bodyObj: Record<string, unknown>) {
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/profiles/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(bodyObj) });
      const j = await r.json();
      if (!r.ok || !j.ok) { alert(j.error || "Update failed"); }
      load();
    } finally { setBusy(false); }
  }

  async function toggleRole(hospital_code: string, role: string, on: boolean) {
    const key = `${hospital_code}|${role}`;
    setRoles((prev) => { const s = new Set(prev); if (on) s.delete(key); else s.add(key); return s; });
    try {
      await fetch(`/api/admin/profiles/${id}/roles`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hospital_code, role, granted: !on }) });
    } catch { load(); }
  }

  async function deleteUser() {
    if (!confirm(`Permanently delete ${profile?.full_name}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/profiles/${id}`, { method: "DELETE" });
      const j = await r.json();
      if (!r.ok || !j.ok) { alert(j.error || "Delete failed"); setBusy(false); return; }
      window.location.href = "/admin/users";
    } finally { setBusy(false); }
  }

  async function resetPin() {
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/profiles/${id}/reset-pin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin }) });
      const j = await r.json();
      if (!r.ok || !j.ok) { alert(j.error || "Reset failed"); return; }
      setResetResult(pin);
      load();
    } finally { setBusy(false); }
  }

  if (loading) return (<><TopNav /><main className="max-w-[1000px] mx-auto px-8 py-8 text-sm text-stone-500">Loading…</main></>);
  if (err || !profile) return (<><TopNav /><main className="max-w-[1000px] mx-auto px-8 py-8"><div className="text-sm text-red-700">{err || "Not found"}</div><Link href="/admin/users" className="text-brand text-sm">← Back to users</Link></main></>);

  const identityDirty = fullName.trim() !== profile.full_name || position !== profile.position_label || hospital !== (profile.hospital_code ?? "");

  return (
    <>
      <TopNav />
      <main className="max-w-[1000px] mx-auto px-8 py-8">
        <div className="text-sm text-stone-500 mb-2">
          <Link href="/admin" className="hover:text-stone-900">Admin</Link>
          <span className="mx-1.5">/</span>
          <Link href="/admin/users" className="hover:text-stone-900">Users</Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-900 font-medium">{profile.full_name}</span>
        </div>

        {/* Hero */}
        <div className="flex items-center gap-4 mb-6">
          <span className={`w-14 h-14 rounded-full inline-flex items-center justify-center text-base font-medium ${colorFor(profile.full_name)}`}>{initials(profile.full_name)}</span>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-[22px] font-semibold tracking-tight">{profile.full_name}</h1>
              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${STATUS_PILL[profile.status] ?? "bg-stone-100 text-stone-600"}`}>{profile.status.replace("_"," ")}</span>
              {profile.is_super_admin && <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-teal-100 text-teal-800">Super Admin</span>}
            </div>
            <div className="text-sm text-stone-500 mt-0.5">{profile.email} · {profile.position_label}{profile.hospital_code ? ` · ${profile.hospital_code}` : ""}</div>
            <div className="text-[11px] text-stone-400 mt-0.5">Last login {profile.last_login_at ? new Date(profile.last_login_at).toISOString().slice(0,10) : "never"} · created {profile.created_at?.slice(0,10)}</div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          {/* Identity */}
          <section className="bg-white border border-stone-200 rounded-xl p-5">
            <h2 className="text-sm font-semibold mb-3">Identity</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1">Full name</label>
                <input value={fullName} onChange={(e) => setFullName(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand" />
              </div>
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1">Email</label>
                <input value={profile.email} disabled className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-stone-50 text-stone-500" />
                <div className="text-[11px] text-stone-400 mt-1">Email is the login identity and can't be edited here.</div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1">Position</label>
                  <select value={position} onChange={(e) => setPosition(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white">
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
              <button
                disabled={!identityDirty || busy}
                onClick={() => patch({ full_name: fullName.trim(), position_name: position, hospital_code: hospital })}
                className="bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50 disabled:cursor-not-allowed">
                {busy ? "Saving…" : "Save identity"}
              </button>
            </div>
          </section>

          {/* Access & status */}
          <section className="bg-white border border-stone-200 rounded-xl p-5">
            <h2 className="text-sm font-semibold mb-3">Access &amp; status</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1">Status</label>
                <select value={profile.status} disabled={busy} onChange={(e) => patch({ status: e.target.value })} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white">
                  <option value="active">Active</option>
                  <option value="suspended">Suspended</option>
                  <option value="deactivated">Deactivated</option>
                  <option value="pending_approval">Pending approval</option>
                  <option value="rejected">Rejected</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={profile.is_super_admin} disabled={busy} onChange={(e) => patch({ is_super_admin: e.target.checked })} className="accent-teal-600" />
                Super Admin (network-wide)
              </label>
              <div className="pt-2 border-t border-stone-100">
                <button disabled={busy} onClick={resetPin} className="text-sm text-brand font-medium hover:underline disabled:opacity-50">Reset PIN</button>
                {resetResult && (
                  <div className="mt-1.5 text-xs bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-amber-800">
                    New temporary PIN: <span className="num font-semibold">{resetResult}</span> — share it with the user. They'll be prompted to set their own on next login.
                  </div>
                )}
                {profile.must_change_pin && !resetResult && (
                  <div className="mt-1.5 text-[11px] text-amber-700">This user must change their PIN on next login.</div>
                )}
              </div>
              <div className="pt-2 border-t border-stone-100">
                <button disabled={busy} onClick={deleteUser} className="text-sm text-red-700 font-medium hover:underline disabled:opacity-50">Delete user</button>
                <div className="text-[11px] text-stone-400 mt-1">Hard delete — only for accounts created in error. Users who authored feedback can't be deleted (deactivate instead).</div>
              </div>
            </div>
          </section>
        </div>

        {/* Per-hospital roles */}
        <section className="bg-white border border-stone-200 rounded-xl p-5 mt-4">
          <h2 className="text-sm font-semibold mb-1">Per-hospital roles</h2>
          <p className="text-[11px] text-stone-400 mb-3">Grants are immediate. Super Admin is network-wide and set above.</p>
          <div className="overflow-x-auto">
            <table className="text-[12px]">
              <thead>
                <tr className="text-stone-500">
                  <th className="text-left pr-4 py-1 font-medium">Hospital</th>
                  {ROLE_COLS.map((role) => <th key={role} className="px-4 py-1 font-medium text-center" title={ROLE_META[role].desc}>{ROLE_META[role].short}</th>)}
                </tr>
              </thead>
              <tbody>
                {hospitals.map((h) => (
                  <tr key={h.code} className="border-t border-stone-200/50">
                    <td className="pr-4 py-1.5 font-medium text-stone-700">{h.code}</td>
                    {ROLE_COLS.map((role) => {
                      const on = roles.has(`${h.code}|${role}`);
                      return (
                        <td key={role} className="px-4 py-1.5 text-center">
                          <input type="checkbox" checked={on} onChange={() => toggleRole(h.code, role, on)} className="w-4 h-4 accent-teal-600 cursor-pointer" />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Audit */}
        <section className="bg-white border border-stone-200 rounded-xl p-5 mt-4">
          <h2 className="text-sm font-semibold mb-3">Audit trail</h2>
          {audit.length === 0 ? (
            <div className="text-sm text-stone-500">No changes recorded yet.</div>
          ) : (
            <div className="divide-y divide-stone-100">
              {audit.map((a) => (
                <div key={a.id} className="py-2 flex items-center gap-3 text-xs">
                  <span className="px-2 py-0.5 rounded-full font-medium bg-stone-100 text-stone-700">{a.action}</span>
                  <span className="text-stone-500">{a.entity_type}</span>
                  <span className="text-stone-400 ml-auto">{a.actor_email ?? "—"} · {timeAgo(a.created_at)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </>
  );
}
