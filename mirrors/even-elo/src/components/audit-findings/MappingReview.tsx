"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { TopNav } from "@/components/TopNav";
import { formatDateTime } from "@/components/audit-findings/FindingsTable";

interface Candidate {
  physician_id: string;
  physician_name: string;
  linked_uid: string | null;
  confirmable: boolean;
}
interface Item {
  uid: string;
  name: string;
  reason: string;
  reason_text: string;
  disabled: boolean;
  candidates: Candidate[];
}
interface Decision {
  id: string;
  decision: "confirm" | "reject";
  cdmss_uid: string;
  cdmss_name: string | null;
  physician_name: string | null;
  reason: string | null;
  decided_by_email: string;
  decided_at: string;
}
interface Payload {
  ok: boolean;
  items?: Item[];
  recent?: Decision[];
  directory_count?: number;
  coverage?: { before: { physician_percent: number; linked_physicians: number; active_physicians: number } };
  decisions_available?: boolean;
  message?: string;
}

export function MappingReview() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    return fetch("/api/audit-findings/mapping")
      .then(async (r) => ({ code: r.status, body: (await r.json().catch(() => ({}))) as Payload }))
      .then(({ code, body }) => {
        if (body.ok) {
          setData(body);
          setError(null);
        } else if (code === 401 || code === 403) {
          setError("Only a super admin or Site Medical Head can review doctor links.");
        } else {
          setError(body.message ?? "The review list could not be loaded.");
        }
      })
      .catch(() => setError("The review list could not be loaded."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(decision: "confirm" | "reject", item: Item, c: Candidate) {
    const verb = decision === "confirm" ? "Link" : "Reject";
    const msg =
      decision === "confirm"
        ? `Link ${c.physician_name} to CDMSS doctor ${item.name}? Findings routed to ${item.name} will appear for ${c.physician_name}.`
        : `Reject the match between ${c.physician_name} and ${item.name}? It will stop being offered.`;
    if (!confirm(msg)) return;
    const key = `${item.uid}|${c.physician_id}`;
    setBusy(key);
    setNotice(null);
    try {
      const res = await fetch("/api/audit-findings/mapping", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, uid: item.uid, physician_id: c.physician_id }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      setNotice(body.ok ? `${verb === "Link" ? "Linked" : "Rejected"}: ${c.physician_name} and ${item.name}.` : body.message ?? "The decision could not be recorded.");
    } catch {
      setNotice("The request did not reach the server. Nothing was changed.");
    } finally {
      setBusy(null);
      await load();
    }
  }

  return (
    <>
      <TopNav />
      <main className="mx-auto max-w-[1100px] px-6 py-8 lg:px-8">
        <div className="mb-3 flex items-center gap-1.5 text-[13px] text-stone-500">
          <Link href="/overview" className="font-medium text-brand hover:underline">Governance</Link>
          <span className="text-stone-400">/</span>
          <Link href="/audit-findings" className="font-medium text-brand hover:underline">Audit findings</Link>
          <span className="text-stone-400">/</span>
          <span className="font-semibold text-stone-900">Doctor mapping review</span>
        </div>
        <h1 className="text-[1.55rem] font-bold tracking-tight text-stone-900">Doctor mapping review</h1>
        <p className="mb-4 mt-1 max-w-2xl text-sm text-stone-500">
          The automatic matcher links a physician to a CDMSS doctor only when the name (and phone) are certain. These are the
          weaker matches. Confirming links the pair and is recorded with your name and the time; rejecting stops the pair being
          offered. A physician who is already linked is never overwritten here.
        </p>
        {data?.coverage ? (
          <p className="mb-4 text-[12.5px] text-stone-600">
            {data.coverage.before.linked_physicians} of {data.coverage.before.active_physicians} active physicians are linked
            ({data.coverage.before.physician_percent}%). {data.directory_count} doctors in the CDMSS directory.
          </p>
        ) : null}
        {notice ? (
          <div role="status" className="mb-4 rounded-lg border border-stone-200 bg-white px-3 py-2 text-[13px] text-stone-800">{notice}</div>
        ) : null}
        {data && data.decisions_available === false ? (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-950">
            The decisions table is not set up yet (run the pending migration), so decisions cannot be saved.
          </div>
        ) : null}
        {error ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-950">{error}</div>
        ) : loading && !data ? (
          <div className="py-10 text-center text-sm text-stone-400">Loading…</div>
        ) : (
          <>
            <section className="rounded-xl border border-stone-200 bg-white px-5 py-4">
              <h2 className="mb-2 text-sm font-semibold">
                To review{" "}
                <span className="ml-1 rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-stone-600">{data?.items?.length ?? 0}</span>
              </h2>
              {(data?.items ?? []).length === 0 ? (
                <div className="py-6 text-center text-sm text-stone-500">No weak matches are waiting.</div>
              ) : (
                <ul className="divide-y divide-stone-100">
                  {(data?.items ?? []).map((item) => (
                    <li key={item.uid} className="py-3">
                      <div className="text-[13.5px] font-semibold text-stone-900">
                        CDMSS doctor: {item.name}
                        {item.disabled ? <span className="ml-2 rounded-full bg-stone-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-stone-600">disabled in CDMSS</span> : null}
                      </div>
                      <div className="text-[12px] text-stone-500">{item.reason_text}</div>
                      <ul className="mt-2 space-y-1.5">
                        {item.candidates.map((c) => {
                          const key = `${item.uid}|${c.physician_id}`;
                          return (
                            <li key={c.physician_id} className="flex flex-wrap items-center gap-2 rounded-lg bg-stone-50 px-3 py-2 text-[13px]">
                              <Link href={`/physicians/${c.physician_id}`} className="font-medium text-brand hover:underline">{c.physician_name}</Link>
                              {c.linked_uid ? <span className="text-[11.5px] text-stone-500">already linked to another CDMSS doctor</span> : null}
                              <span className="ml-auto flex gap-2">
                                <button
                                  type="button"
                                  disabled={!c.confirmable || busy === key}
                                  onClick={() => void decide("confirm", item, c)}
                                  className="rounded-md bg-brand px-3 py-1 text-[12px] font-semibold text-white disabled:opacity-40"
                                  title={c.confirmable ? "Link this physician to the CDMSS doctor" : "Already linked; not overwritten here"}
                                >
                                  Confirm link
                                </button>
                                <button
                                  type="button"
                                  disabled={busy === key}
                                  onClick={() => void decide("reject", item, c)}
                                  className="rounded-md border border-stone-300 bg-white px-3 py-1 text-[12px] font-semibold text-stone-700 disabled:opacity-40"
                                >
                                  Reject
                                </button>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="mt-4 rounded-xl border border-stone-200 bg-white px-5 py-4">
              <h2 className="mb-2 text-sm font-semibold">Recent decisions</h2>
              {(data?.recent ?? []).length === 0 ? (
                <div className="text-[13px] text-stone-500">No decisions yet.</div>
              ) : (
                <ul className="space-y-1 text-[12.5px] text-stone-700">
                  {(data?.recent ?? []).map((d) => (
                    <li key={d.id}>
                      <span className="font-semibold">{d.decision === "confirm" ? "Linked" : "Rejected"}</span> {d.physician_name ?? "a physician"} and{" "}
                      {d.cdmss_name ?? d.cdmss_uid} · {d.decided_by_email} · {formatDateTime(d.decided_at)}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
    </>
  );
}
