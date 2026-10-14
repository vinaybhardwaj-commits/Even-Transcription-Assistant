"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import { TopNav } from "@/components/TopNav";

interface Incident {
  id: string;
  target_physician_id: string;
  target_physician_name: string;
  target_physician_email: string | null;
  submitted_at: string;
  anonymous_flag: boolean;
  submitter_label: string;
  hospital_code: string | null;
  category: string | null;
  severity: string | null;
  polarity: string;
  source: string;
  commendation_category: string | null;
  patient_rating: number | null;
  patient_ref: string | null;
  narrative: string;
  evidence_urls: string[];
  status: string;
  retracted_by_email: string | null;
  retracted_at: string | null;
  retraction_reason: string | null;
  can_retract: boolean;
  can_reclassify: boolean;
  can_reply: boolean;
  can_delete: boolean;
}

interface Reply {
  id: string;
  reply_text: string;
  replied_at: string;
  replied_by_email: string;
  replied_by_name: string | null;
}

const SEV_PILL: Record<string, string> = {
  low: "bg-stone-100 text-stone-700",
  medium: "bg-amber-50 text-amber-800",
  high: "bg-orange-50 text-orange-800",
  critical: "bg-red-50 text-red-800",
};
const STATUS_PILL: Record<string, string> = {
  open: "bg-emerald-50 text-emerald-700",
  closed: "bg-stone-100 text-stone-600",
  retracted: "bg-red-50 text-red-700",
};
const CATEGORY_LABEL: Record<string, string> = {
  clinical: "Clinical",
  patient_safety: "Patient safety",
  medical_error: "Medical error",
  professionalism: "Professionalism",
  documentation: "Documentation",
  etiquette: "Etiquette",
  vendor_compliance: "Vendor compliance",
  other: "Other",
};
const SEVERITIES = ["low", "medium", "high", "critical"] as const;

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function Inner() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const sp = useSearchParams();
  const justSubmitted = sp?.get("just_submitted") === "1";
  const id = params?.id;

  const [data, setData] = useState<{ incident: Incident; replies: Reply[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [working, setWorking] = useState(false);

  function load() {
    if (!id) return;
    setLoading(true);
    fetch(`/api/incidents/${id}`)
      .then((r) => r.json())
      .then((j) => {
        if (!j.ok) { setError(j.error || "Not found"); return; }
        setData({ incident: j.incident, replies: j.replies ?? [] });
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  async function postReply() {
    if (!reply.trim()) return;
    setWorking(true);
    try {
      const r = await fetch(`/api/incidents/${id}/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reply_text: reply.trim() }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        alert(j.error || "Reply failed");
        return;
      }
      setReply("");
      load();
    } finally {
      setWorking(false);
    }
  }

  async function deleteIncident() {
    if (!confirm("Permanently delete this feedback record? This cannot be undone.")) return;
    setWorking(true);
    try {
      const r = await fetch(`/api/incidents/${id}`, { method: "DELETE" });
      const j = await r.json();
      if (!r.ok || !j.ok) { alert(j.error || "Delete failed"); setWorking(false); return; }
      window.location.href = "/incidents";
    } catch { setWorking(false); }
  }

  async function changeSeverity(newSev: string) {
    if (!data) return;
    if (newSev === data.incident.severity) return;
    const reason = prompt(`Change severity to ${newSev}? Optional reason (will be visible in audit):`);
    if (reason === null) return;
    setWorking(true);
    try {
      const r = await fetch(`/api/incidents/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ severity: newSev }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) alert(j.error || "Severity update failed");
      load();
    } finally { setWorking(false); }
  }

  async function markReviewed() {
    if (!id) return;
    setWorking(true);
    try {
      const r = await fetch(`/api/incidents/${id}/view`, { method: "POST" });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        alert(j.error || "Could not mark reviewed");
      }
    } finally {
      setWorking(false);
    }
  }

  async function retract() {
    const reason = prompt("Retraction reason (required — will display struck-through on the incident):");
    if (!reason || !reason.trim()) return;
    setWorking(true);
    try {
      const r = await fetch(`/api/incidents/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "retracted", retraction_reason: reason.trim() }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) alert(j.error || "Retract failed");
      load();
    } finally { setWorking(false); }
  }

  async function toggleStatus(newStatus: "open" | "closed") {
    setWorking(true);
    try {
      const r = await fetch(`/api/incidents/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) alert(j.error || "Status update failed");
      load();
    } finally { setWorking(false); }
  }

  if (loading) return (<><TopNav /><main className="max-w-[900px] mx-auto px-8 py-8 text-sm text-stone-500">Loading…</main></>);
  if (error || !data) return (
    <>
      <TopNav />
      <main className="max-w-[900px] mx-auto px-8 py-12 text-center">
        <h1 className="text-lg font-semibold mb-2">{error || "Incident not found"}</h1>
        <Link href="/incidents" className="text-brand text-sm font-medium">← Back to incidents</Link>
      </main>
    </>
  );

  const i = data.incident;
  const isRetracted = i.status === "retracted";

  return (
    <>
      <TopNav />
      <main className="max-w-[900px] mx-auto px-8 py-8">
        <div className="text-sm text-stone-500 mb-2">
          <Link href="/incidents" className="hover:text-stone-900">Patient Feedback</Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-900 font-medium">#{i.id.slice(0, 8)}</span>
        </div>

        {justSubmitted && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 mb-4 text-sm text-emerald-800">
            ✓ Report submitted. {i.target_physician_name} will see it on their profile immediately.
          </div>
        )}

        {/* Header card */}
        <section className="bg-white border border-stone-200 rounded-xl p-5 mb-4">
          <div className="flex items-start gap-1.5 mb-3 flex-wrap">
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${i.polarity === "positive" ? "bg-emerald-50 text-emerald-700" : "bg-stone-800 text-white"}`}>
              {i.polarity === "positive" ? "Positive" : "Negative"}
            </span>
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-violet-50 text-violet-700">
              {i.source === "patient" ? "Patient" : i.source === "governance" ? "Governance" : "Peer"}
            </span>
            {i.polarity === "positive"
              ? (i.commendation_category ? <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700">{i.commendation_category}</span> : null)
              : <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${SEV_PILL[i.severity ?? ""] ?? "bg-stone-100 text-stone-700"}`}>{i.severity ?? "\u2014"}</span>}
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${STATUS_PILL[i.status] ?? "bg-stone-100 text-stone-700"}`}>
              {i.status}
            </span>
            {i.polarity !== "positive" && (
              <span className="text-[11px] text-stone-500 px-2 py-0.5 rounded-full bg-stone-50">
                {CATEGORY_LABEL[i.category ?? ""] ?? i.category}
              </span>
            )}
            {i.patient_rating != null && <span className="text-[11px] text-amber-700 px-2 py-0.5 rounded-full bg-amber-50">{"\u2605"} {i.patient_rating}/5</span>}
            {i.hospital_code && (
              <span className="text-[11px] text-stone-500 px-2 py-0.5 rounded-full bg-stone-50">{i.hospital_code}</span>
            )}
          </div>

          <h1 className={`text-lg font-semibold ${isRetracted ? "line-through text-stone-500" : ""}`}>
            {i.polarity === "positive" ? "Feedback on" : "Report on"} <Link href={`/physicians/${i.target_physician_id}`} className="text-brand hover:underline">{i.target_physician_name}</Link>
          </h1>
          <div className="text-xs text-stone-500 mt-1">
            Submitted {fmtTime(i.submitted_at)} ·{" "}
            {i.anonymous_flag ? <span className="font-medium">Anonymous</span> : <span>{i.submitter_label}</span>}
          </div>

          {isRetracted && (
            <div className="mt-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">
              <strong>Retracted</strong>
              {i.retracted_at ? ` ${fmtTime(i.retracted_at)}` : ""}
              {i.retracted_by_email ? ` by ${i.retracted_by_email}` : ""}
              {i.retraction_reason ? ` · ${i.retraction_reason}` : ""}
            </div>
          )}

          <div className={`mt-4 text-sm leading-relaxed whitespace-pre-wrap ${isRetracted ? "line-through text-stone-500" : "text-stone-800"}`}>
            {i.narrative}
          </div>

          {i.evidence_urls.length > 0 && (
            <div className="mt-4 pt-4 border-t border-stone-100">
              <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase mb-2">Evidence</div>
              <ul className="space-y-1">
                {i.evidence_urls.map((u, ix) => (
                  <li key={ix}><a href={u} target="_blank" rel="noreferrer" className="text-brand text-xs break-all hover:underline">{u}</a></li>
                ))}
              </ul>
            </div>
          )}

          {/* Super-admin actions */}
          {(i.can_retract || i.can_reclassify) && (
            <div className="mt-5 pt-4 border-t border-stone-100 flex flex-wrap items-center gap-2">
              {i.can_reclassify && !isRetracted && (
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-stone-500">Re-classify severity:</span>
                  {SEVERITIES.map((sv) => (
                    <button
                      key={sv}
                      onClick={() => changeSeverity(sv)}
                      disabled={working || sv === i.severity}
                      className={`px-2 py-1 rounded text-[11px] font-medium border ${
                        sv === i.severity ? "border-stone-700 ring-1 ring-stone-300 cursor-default" : "border-stone-200 hover:bg-stone-50"
                      } ${SEV_PILL[sv]}`}
                    >
                      {sv}
                    </button>
                  ))}
                </div>
              )}
              <div className="ml-auto flex gap-2">
                <button onClick={markReviewed} disabled={working} className="btn-ghost text-xs" title="Mark this incident as reviewed for you. Auto-clears from your badge.">
                  ✓ Mark reviewed
                </button>
                {!isRetracted && i.status === "open" && (
                  <button onClick={() => toggleStatus("closed")} disabled={working} className="btn-ghost text-xs">Close</button>
                )}
                {!isRetracted && i.status === "closed" && (
                  <button onClick={() => toggleStatus("open")} disabled={working} className="btn-ghost text-xs">Reopen</button>
                )}
                {i.can_retract && (
                  <button onClick={retract} disabled={working} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-50 text-red-700 hover:bg-red-100">
                    Retract
                  </button>
                )}
                {i.can_delete && (
                  <button onClick={deleteIncident} disabled={working} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-100 text-red-800 hover:bg-red-200">
                    Delete
                  </button>
                )}
              </div>
            </div>
          )}
        </section>

        {/* Reply thread */}
        <section className="bg-white border border-stone-200 rounded-xl">
          <div className="px-5 py-3.5 border-b border-stone-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Right-of-reply</h2>
            <span className="text-[11px] bg-stone-100 text-stone-600 rounded-full px-2 py-0.5 font-medium">{data.replies.length}</span>
          </div>
          {data.replies.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-stone-500">
              {i.can_reply ? "No replies yet. The target physician can post the first reply below." : "No replies yet."}
            </div>
          ) : (
            <div className="divide-y divide-stone-100">
              {data.replies.map((r) => (
                <div key={r.id} className="px-5 py-4">
                  <div className="text-xs text-stone-500 mb-1.5">
                    <strong className="text-stone-700">{r.replied_by_name ?? r.replied_by_email.split("@")[0]}</strong>
                    {" · "}
                    {fmtTime(r.replied_at)}
                  </div>
                  <div className="text-sm text-stone-800 whitespace-pre-wrap leading-relaxed">{r.reply_text}</div>
                </div>
              ))}
            </div>
          )}
          {i.can_reply && !isRetracted && (
            <div className="px-5 py-4 border-t border-stone-100">
              <label className="block text-xs font-medium text-stone-500 mb-1.5">Your reply (unlimited length, no review)</label>
              <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                rows={4}
                placeholder="State the facts as you understand them. Replies are permanent."
                className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand leading-relaxed"
              />
              <div className="flex justify-end mt-2">
                <button
                  onClick={postReply}
                  disabled={!reply.trim() || working}
                  className="bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-60"
                >
                  {working ? "Posting…" : "Post reply"}
                </button>
              </div>
            </div>
          )}
        </section>

        <div className="text-[11px] text-stone-400 mt-4 text-center">
          Feedback {i.id}
        </div>
      </main>
    </>
  );
}

export default function IncidentDetailPage() {
  return (
    <Suspense fallback={<div className="text-sm text-stone-500 px-8 py-8">Loading…</div>}>
      <Inner />
    </Suspense>
  );
}
