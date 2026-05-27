"use client";

/**
 * DoctorDetailClient — Sprint 10 Doctor profile (Figma S3 detail).
 *
 * Hero + 4 KPIs + Account & access (editable) + URL section + PIN
 * section + Sessions stub + Recent encounters + Recipients (read-only)
 * + Audit + Danger zone. Per V's Q2 lock — full Figma feature set.
 *
 * Mutating actions wire to existing endpoints (PATCH /api/admin/doctors/
 * [id], POST .../reset-pin) plus new ones (.../rotate-url, .../email-url).
 * Force logout is stubbed pending v2 (JWT can't be revoked without
 * adding a session_revoked_at column + verify-time check).
 */

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";

type Doctor = {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  url_slug: string;
  url_token: string;
  status: "active" | "disabled" | "locked";
  pin_set_at: string | null;
  failed_pin_count: number;
  locked_until: string | null;
  last_active_at: string | null;
  joined_at: string;
  deleted_at: string | null;
};
type Kpi = { encounters_30d: number; encounters_total: number; sent_30d: number; failed_30d: number; send_success_30d_pct: number | null; active_days_30d: number };
type Encounter = { id: string; patient_label_raw: string | null; chief_complaint: string | null; recorded_at: string; duration_seconds: number | null; send_status: "pending" | "sent" | "failed" };
type Recipient = { id: string; email: string; name: string; role: string; set_by: string };
type AuditEntry = { id: string; actor_type: "admin" | "doctor" | "system"; actor_id: string | null; action: string; metadata_json: unknown; created_at: string };
type DoctorBundle = { doctor: Doctor | null; kpis: Kpi; recent_encounters: Encounter[]; recipients: Recipient[]; audit_log: AuditEntry[] };

export function DoctorDetailClient({ doctorId }: { doctorId: string }) {
  const [data, setData] = React.useState<DoctorBundle | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [banner, setBanner] = React.useState<{ kind: "info" | "error"; message: string; details?: string } | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [editName, setEditName] = React.useState("");
  const [editEmail, setEditEmail] = React.useState("");
  const [editPhone, setEditPhone] = React.useState("");
  const [showDelete, setShowDelete] = React.useState(false);
  const [actionInflight, setActionInflight] = React.useState(false);
  const [copyState, setCopyState] = React.useState<"idle" | "copied">("idle");

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/doctors/${doctorId}`, { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
      setData(j as DoctorBundle);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [doctorId]);
  React.useEffect(() => { void load(); }, [load]);

  const d = data?.doctor ?? null;
  const k = data?.kpis ?? null;

  const beginEdit = () => {
    if (!d) return;
    setEditName(d.full_name);
    setEditEmail(d.email);
    setEditPhone(d.phone ?? "");
    setEditing(true);
  };
  const saveEdit = async () => {
    if (!d) return;
    setActionInflight(true);
    try {
      const res = await fetch(`/api/admin/doctors/${doctorId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ full_name: editName, email: editEmail, phone: editPhone || "" }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
      setBanner({ kind: "info", message: "Profile updated." });
      setEditing(false);
      await load();
    } catch (e) {
      setBanner({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setActionInflight(false);
    }
  };

  const toggleStatus = async () => {
    if (!d) return;
    const next = d.status === "active" ? "disabled" : "active";
    setActionInflight(true);
    try {
      const res = await fetch(`/api/admin/doctors/${doctorId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
      }
      setBanner({ kind: "info", message: `Doctor ${next}.` });
      await load();
    } catch (e) {
      setBanner({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setActionInflight(false);
    }
  };

  const unlock = async () => {
    if (!d) return;
    setActionInflight(true);
    try {
      // PATCH status='active' to clear the lock + status flip
      const res = await fetch(`/api/admin/doctors/${doctorId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
      }
      setBanner({ kind: "info", message: "Doctor unlocked." });
      await load();
    } catch (e) {
      setBanner({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setActionInflight(false);
    }
  };

  const resetPin = async () => {
    if (!d) return;
    if (!confirm(`Reset PIN for ${d.full_name}? They'll need the new PIN to sign in.`)) return;
    setActionInflight(true);
    try {
      const res = await fetch(`/api/admin/doctors/${doctorId}/reset-pin`, { method: "POST" });
      const j = await res.json();
      if (!res.ok) throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
      const payload = j as { pin_plaintext: string; login_url: string };
      setBanner({
        kind: "info",
        message: `PIN reset for ${d.full_name}.`,
        details: `New PIN: ${payload.pin_plaintext}    Login URL: ${payload.login_url}    (PIN shown once.)`,
      });
      await load();
    } catch (e) {
      setBanner({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setActionInflight(false);
    }
  };

  const rotateUrl = async () => {
    if (!d) return;
    if (!confirm("Rotate URL token? The doctor's current URL will stop working immediately. They'll need the new URL.")) return;
    setActionInflight(true);
    try {
      const res = await fetch(`/api/admin/doctors/${doctorId}/rotate-url`, { method: "POST" });
      const j = await res.json();
      if (!res.ok) throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
      const payload = j as { doctor: { url_slug: string; login_url: string } };
      setBanner({
        kind: "info",
        message: `URL rotated. New URL: ${payload.doctor.login_url}`,
      });
      await load();
    } catch (e) {
      setBanner({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setActionInflight(false);
    }
  };

  const emailUrl = async () => {
    if (!d) return;
    setActionInflight(true);
    try {
      const res = await fetch(`/api/admin/doctors/${doctorId}/email-url`, { method: "POST" });
      const j = await res.json();
      if (!res.ok) throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
      setBanner({ kind: "info", message: `URL emailed to ${d.email}.` });
    } catch (e) {
      setBanner({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setActionInflight(false);
    }
  };

  const onDelete = async () => {
    setActionInflight(true);
    try {
      const res = await fetch(`/api/admin/doctors/${doctorId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleted: true }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
      setBanner({ kind: "info", message: "Doctor deleted (soft). Encounters preserved." });
      setShowDelete(false);
      await load();
    } catch (e) {
      setBanner({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setActionInflight(false);
    }
  };

  const copyUrl = async () => {
    if (!d) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/${d.url_slug}`);
      setCopyState("copied");
      globalThis.setTimeout(() => setCopyState("idle"), 1500);
    } catch { /* clipboard denied */ }
  };

  const fmtDate = (iso: string | null) => {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };
  const fmtDur = (sec: number | null) => {
    if (sec == null) return "—";
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  if (loading && !data) return <p className="text-body text-even-ink-500">Loading…</p>;
  if (error) return <div className="rounded-md border border-danger-500 bg-danger-100/40 p-3 text-body text-danger-700">Could not load: {error}</div>;
  if (!d) return null;

  const initials = d.full_name.split(/\s+/).map((p) => p[0]?.toUpperCase() ?? "").slice(0, 2).join("");

  return (
    <div className="space-y-6">
      <Link href="/admin/doctors" className="text-caption text-even-blue-600 hover:underline">‹ Back to doctors</Link>

      {banner ? (
        <div className={`rounded-md border p-3 text-body ${banner.kind === "error" ? "border-danger-500 bg-danger-100/40 text-danger-700" : "border-success-500 bg-success-100/40 text-even-ink-800"}`}>
          <p className="font-semibold">{banner.message}</p>
          {banner.details ? (
            <p className="mt-1 text-caption text-even-ink-700 whitespace-pre-line font-mono">{banner.details}</p>
          ) : null}
          <button type="button" onClick={() => setBanner(null)} className="text-caption text-even-ink-500 hover:underline mt-2">Dismiss</button>
        </div>
      ) : null}

      {/* Hero */}
      <div className="rounded-xl border border-even-ink-100 bg-even-white p-5 flex items-start justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <span className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-even-navy-800 text-even-white text-label font-semibold shrink-0">
            {initials}
          </span>
          <div className="min-w-0">
            <h2 className="text-heading text-even-navy-800 truncate">{d.full_name}</h2>
            <p className="text-caption text-even-ink-500 truncate" suppressHydrationWarning>
              {d.email}{d.phone ? ` · ${d.phone}` : ""}
            </p>
            <p className="text-caption text-even-ink-500 mt-1">
              <code className="font-mono">{d.id}</code>
              {d.last_active_at ? <> · last active {fmtDate(d.last_active_at)}</> : null}
              <> · joined {fmtDate(d.joined_at)}</>
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <StatusPill status={d.status} deleted={d.deleted_at !== null} />
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => void emailUrl()} disabled={actionInflight || d.deleted_at !== null}>✉ Email URL</Button>
            {d.status === "locked" ? (
              <Button variant="primary" size="sm" onClick={() => void unlock()} disabled={actionInflight}>Unlock</Button>
            ) : null}
          </div>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Encounters · 30d"     value={k?.encounters_30d ?? "—"} />
        <KpiCard label="Encounters · total"   value={k?.encounters_total ?? "—"} />
        <KpiCard label="Send success · 30d"   value={k?.send_success_30d_pct == null ? "—" : `${k.send_success_30d_pct}%`}
                 sub={k ? `${k.sent_30d} of ${k.sent_30d + k.failed_30d} delivered` : ""} />
        <KpiCard label="Active days · 30d"    value={k?.active_days_30d ?? "—"} />
      </div>

      {/* Two-column body */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr,300px] gap-6">
        {/* Left: Account & access + Recent encounters + Audit */}
        <div className="space-y-4">
          {/* Account & access card */}
          <section className="rounded-xl border border-even-ink-100 bg-even-white p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-label text-even-navy-800">Account &amp; access</h3>
              {!editing ? (
                <button type="button" onClick={beginEdit} className="text-caption text-even-blue-600 hover:underline">Edit</button>
              ) : null}
            </div>
            {editing ? (
              <div className="space-y-2">
                <input type="text"  value={editName}  onChange={(e) => setEditName(e.target.value)}  placeholder="Full name" minLength={2}
                  className="w-full rounded-md border border-even-ink-200 px-3 py-2 text-body focus:outline-none focus:ring-2 focus:ring-even-blue-300" />
                <input type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} placeholder="email"
                  className="w-full rounded-md border border-even-ink-200 px-3 py-2 text-body focus:outline-none focus:ring-2 focus:ring-even-blue-300" />
                <input type="tel"   value={editPhone} onChange={(e) => setEditPhone(e.target.value)} placeholder="phone"
                  className="w-full rounded-md border border-even-ink-200 px-3 py-2 text-body focus:outline-none focus:ring-2 focus:ring-even-blue-300" />
                <div className="flex justify-end gap-2 pt-1">
                  <Button variant="secondary" size="sm" onClick={() => setEditing(false)} disabled={actionInflight}>Cancel</Button>
                  <Button variant="primary"   size="sm" onClick={() => void saveEdit()}   disabled={actionInflight}>{actionInflight ? "Saving…" : "Save"}</Button>
                </div>
              </div>
            ) : (
              <dl className="grid grid-cols-[140px,1fr] gap-y-1.5 text-body">
                <dt className="text-caption text-even-ink-500">Full name</dt>     <dd className="text-even-navy-800">{d.full_name}</dd>
                <dt className="text-caption text-even-ink-500">Email</dt>         <dd className="text-even-navy-800">{d.email}</dd>
                <dt className="text-caption text-even-ink-500">Phone</dt>         <dd className="text-even-navy-800">{d.phone ?? <span className="text-even-ink-400">—</span>}</dd>
              </dl>
            )}
            <hr className="my-4 border-even-ink-100" />
            <h4 className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 mb-2">URL · personal</h4>
            <p className="text-caption font-mono text-even-navy-800 break-all">
              /{d.url_slug}
            </p>
            <div className="flex flex-wrap gap-2 mt-2">
              <Button variant="secondary" size="sm" onClick={() => void copyUrl()}>
                {copyState === "copied" ? "✓ Copied" : "⎘ Copy"}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void rotateUrl()} disabled={actionInflight}>⟳ Rotate token</Button>
            </div>
            <hr className="my-4 border-even-ink-100" />
            <h4 className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 mb-2">PIN</h4>
            <p className="text-caption text-even-ink-700">
              {d.pin_set_at ? `Set ${fmtDate(d.pin_set_at)}` : <span className="text-even-ink-400">Not set yet</span>}
              {" · "}
              {d.failed_pin_count > 0 ? <span className="text-warning-700">{d.failed_pin_count} failed attempts</span> : "0 failed attempts"}
            </p>
            <div className="flex flex-wrap gap-2 mt-2">
              <Button variant="secondary" size="sm" onClick={() => void resetPin()} disabled={actionInflight}>🔑 Reset PIN</Button>
            </div>
            <hr className="my-4 border-even-ink-100" />
            <h4 className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 mb-2">Sessions</h4>
            <p className="text-caption text-even-ink-500">
              Force-logout requires a session_revoked_at column + verify-time
              check (deferred to v2). For now, rotating the URL token does
              not invalidate existing JWT sessions either — they expire on
              their own iat-based 30d clock.
            </p>
            <Button variant="ghost" size="sm" disabled className="mt-2">Force logout (v2)</Button>
          </section>

          {/* Recent encounters */}
          <section className="rounded-xl border border-even-ink-100 bg-even-white p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-label text-even-navy-800">Recent encounters</h3>
              <Link href={`/admin/encounters?bucket=all&window=all`} className="text-caption text-even-blue-600 hover:underline">View all →</Link>
            </div>
            {!data || data.recent_encounters.length === 0 ? (
              <p className="text-body text-even-ink-400">No encounters yet.</p>
            ) : (
              <ul className="space-y-2">
                {data.recent_encounters.map((e) => (
                  <li key={e.id} className="border-b border-even-ink-100 last:border-b-0 pb-2 last:pb-0">
                    <Link href={`/admin/encounters/${e.id}`} className="block hover:bg-even-ink-50/40 -mx-2 px-2 py-1 rounded-md">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-body text-even-navy-800 truncate">{e.patient_label_raw ?? <span className="text-even-ink-400">(no label)</span>}</p>
                          <p className="text-caption text-even-ink-500 truncate">{e.chief_complaint ?? "—"}</p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-caption text-even-ink-500" suppressHydrationWarning>{fmtDate(e.recorded_at)}</p>
                          <p className="text-caption font-mono text-even-ink-400">{fmtDur(e.duration_seconds)}</p>
                        </div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Audit */}
          <section className="rounded-xl border border-even-ink-100 bg-even-white p-5">
            <h3 className="text-label text-even-navy-800 mb-3">Audit log</h3>
            {!data || data.audit_log.length === 0 ? (
              <p className="text-body text-even-ink-400">No audit entries yet.</p>
            ) : (
              <ul className="space-y-2">
                {data.audit_log.map((a) => (
                  <li key={a.id} className="flex items-center gap-3 text-caption text-even-ink-700 border-b border-even-ink-100 last:border-b-0 pb-1.5 last:pb-0">
                    <span className="font-mono text-even-ink-400" suppressHydrationWarning>{fmtDate(a.created_at)}</span>
                    <span className="text-even-ink-500">{a.actor_type}</span>
                    <code className="font-mono text-even-navy-800">{a.action}</code>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* Right rail: recipients + danger zone */}
        <aside className="space-y-4">
          <div className="rounded-xl border border-even-ink-100 bg-even-white p-4">
            <p className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 mb-2">Default email recipients</p>
            <p className="text-caption text-even-ink-500 mb-2">
              Always CC&apos;d on this doctor&apos;s sends. Edit in Sprint 11 (Settings).
            </p>
            {!data || data.recipients.length === 0 ? (
              <p className="text-caption text-even-ink-400">None.</p>
            ) : (
              <ul className="space-y-1.5 text-caption">
                {data.recipients.map((r) => (
                  <li key={r.id} className="flex flex-col">
                    <span className="text-even-navy-800">{r.name}</span>
                    <span className="text-even-ink-500">{r.email} · {r.role}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {d.deleted_at ? (
            <div className="rounded-xl border border-even-ink-200 bg-even-ink-50 p-4">
              <p className="text-label text-even-ink-700 mb-1">Deleted</p>
              <p className="text-caption text-even-ink-500" suppressHydrationWarning>Soft-deleted on {fmtDate(d.deleted_at)}.</p>
            </div>
          ) : (
            <div className="rounded-xl border border-danger-500/40 bg-danger-100/30 p-4 space-y-2">
              <p className="text-label text-danger-700">Danger zone</p>
              <p className="text-caption text-even-ink-700">{d.status === "active" ? "Disable to block sign-in" : "Enable to restore access"}.</p>
              <Button variant="secondary" size="sm" onClick={() => void toggleStatus()} disabled={actionInflight}>
                {d.status === "active" ? "Disable" : "Enable"}
              </Button>
              <p className="text-caption text-even-ink-700 pt-2 border-t border-danger-500/20 mt-2">Delete · removes from list. Encounters preserved.</p>
              <Button variant="destructive" size="sm" onClick={() => setShowDelete(true)} disabled={actionInflight}>Delete doctor</Button>
            </div>
          )}
        </aside>
      </div>

      {/* Delete confirm modal */}
      {showDelete ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-even-navy-800/40" onClick={() => !actionInflight && setShowDelete(false)} role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-2xl bg-even-white p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <p className="text-heading text-even-navy-800">Delete {d.full_name}?</p>
            <p className="text-body text-even-ink-700">
              Sign-in stops working. Encounters + audit log are preserved.
              Status becomes 'disabled', deleted_at set. Reversible by clearing
              deleted_at in SQL.
            </p>
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
              <Button variant="secondary" onClick={() => setShowDelete(false)} disabled={actionInflight}>Cancel</Button>
              <Button variant="destructive" onClick={() => void onDelete()} disabled={actionInflight}>
                {actionInflight ? "Deleting…" : "Yes, delete"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function KpiCard({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-xl border border-even-ink-100 bg-even-white p-4">
      <p className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 mb-1">{label}</p>
      <p className="text-heading text-even-navy-800 font-semibold">{value}</p>
      {sub ? <p className="text-caption text-even-ink-500 mt-1">{sub}</p> : null}
    </div>
  );
}

function StatusPill({ status, deleted }: { status: string; deleted: boolean }) {
  if (deleted)     return <span className="text-caption rounded-full px-2 py-0.5 bg-even-ink-100 text-even-ink-500">Deleted</span>;
  if (status === "active")   return <span className="text-caption rounded-full px-2 py-0.5 bg-success-100 text-success-700">Active</span>;
  if (status === "disabled") return <span className="text-caption rounded-full px-2 py-0.5 bg-even-ink-100 text-even-ink-700">Disabled</span>;
  if (status === "locked")   return <span className="text-caption rounded-full px-2 py-0.5 bg-warning-100 text-warning-700">Locked</span>;
  return <span className="text-caption">{status}</span>;
}
