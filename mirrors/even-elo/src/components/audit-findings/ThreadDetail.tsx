"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { TopNav } from "@/components/TopNav";
import { StatusChips, formatDateTime, formatDay } from "@/components/audit-findings/FindingsTable";
import { actionLabel, type FindingRow, type Instance, type SignalAction, type TimelineEntry } from "@/lib/audit-findings";

interface ActionChoice {
  action: SignalAction;
  button: string;
  help: string;
}

interface DetailPayload {
  ok: boolean;
  thread?: FindingRow;
  instances?: Instance[];
  timeline?: TimelineEntry[];
  can_rule?: boolean;
  actions?: ActionChoice[];
  pending_rulings?: Array<{ action: string; attempts: number; since: string | null }>;
  message?: string;
}

interface RulingPayload {
  ok: boolean;
  replayed?: boolean;
  message?: string;
  error?: string;
  current_status?: string | null;
}

const NOTE_MIN = 3;

export function ThreadDetail({ reference }: { reference: string }) {
  const [data, setData] = useState<DetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<SignalAction | "">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    return fetch(`/api/audit-findings/${encodeURIComponent(reference)}`)
      .then(async (r) => ({ code: r.status, body: (await r.json().catch(() => ({}))) as DetailPayload }))
      .then(({ code, body }) => {
        if (body.ok) {
          setData(body);
          setError(null);
        } else if (code === 401 || code === 403) {
          setError("You do not have access to Audit findings.");
        } else {
          setError(body.message ?? "The thread could not be loaded.");
        }
      })
      .catch(() => setError("The thread could not be loaded."))
      .finally(() => setLoading(false));
  }, [reference]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep the chosen action valid when the thread's allowed set changes (after a refresh or a 409).
  useEffect(() => {
    if (action && !(data?.actions ?? []).some((a) => a.action === action)) setAction("");
  }, [data, action]);

  async function submit() {
    if (!action || busy) return;
    if (note.trim().length < NOTE_MIN) {
      setNotice({ tone: "warn", text: "A note is required: say why you are making this ruling." });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/audit-findings/${encodeURIComponent(reference)}/ruling`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, note: note.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as RulingPayload;
      if (res.ok && body.ok) {
        setNotice({ tone: "ok", text: body.replayed ? "This ruling was already recorded. Nothing changed." : "Ruling recorded." });
        setNote("");
        setAction("");
      } else if (res.status === 409) {
        setNotice({
          tone: "warn",
          text: `${body.message ?? "The thread changed."}${body.current_status ? ` Current status: ${body.current_status}.` : ""}`,
        });
      } else {
        setNotice({ tone: "warn", text: body.message ?? "The ruling could not be recorded." });
      }
      // Success, replay and 409 all mean "show me the truth now". A 502 keeps the form so the same press retries.
      if (res.ok || res.status === 409) await load();
    } catch {
      setNotice({ tone: "warn", text: "The request did not reach the server. Press the button again; it will not be recorded twice." });
    } finally {
      setBusy(false);
    }
  }

  const t = data?.thread;

  return (
    <>
      <TopNav />
      <main className="mx-auto max-w-[1000px] px-6 py-8 lg:px-8">
        <div className="mb-3 flex items-center gap-1.5 text-[13px] text-stone-500">
          <Link href="/overview" className="font-medium text-brand hover:underline">Governance</Link>
          <span className="text-stone-400">/</span>
          <Link href="/audit-findings" className="font-medium text-brand hover:underline">Audit findings</Link>
          <span className="text-stone-400">/</span>
          <span className="font-semibold text-stone-900">{reference}</span>
        </div>

        {error ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-950">{error}</div>
        ) : !t ? (
          <div className="py-10 text-center text-sm text-stone-400">{loading ? "Loading…" : ""}</div>
        ) : (
          <div className="space-y-4">
            <section className="rounded-xl border border-stone-200 bg-white px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h1 className="text-[1.35rem] font-bold tracking-tight text-stone-900">{t.finding_type}</h1>
                  <div className="mt-0.5 text-[13px] text-stone-600">
                    {t.physician_id ? (
                      <Link href={`/physicians/${t.physician_id}`} className="font-medium text-brand hover:underline">
                        {t.doctor_name ?? t.doctor_uid}
                      </Link>
                    ) : (
                      <span className="font-medium">{t.doctor_name ?? t.doctor_uid}</span>
                    )}{" "}
                    · {t.note_type} · routed {formatDay(t.routed_at) || "date unknown"}
                  </div>
                </div>
                <button type="button" onClick={() => void load()} className="text-[12px] font-semibold text-brand hover:underline">
                  Refresh
                </button>
              </div>
              <div className="mt-3 text-[14px] font-medium text-stone-900">{t.status_text}</div>
              <StatusChips row={t} />
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-[12.5px] sm:grid-cols-4">
                <div><dt className="text-stone-400">Importance</dt><dd className="font-medium text-stone-800">{t.importance ?? "—"}</dd></div>
                <div><dt className="text-stone-400">Response ask</dt><dd className="font-medium text-stone-800">{t.response_required_text}</dd></div>
                <div><dt className="text-stone-400">Reply due</dt><dd className="font-medium text-stone-800">{formatDay(t.sla_due_at) || "—"}</dd></div>
                <div><dt className="text-stone-400">Notes in window</dt><dd className="font-medium text-stone-800">{t.instances ?? "—"}</dd></div>
              </dl>
            </section>

            <section className="rounded-xl border border-stone-200 bg-white px-5 py-4">
              <h2 className="mb-2 text-sm font-semibold">Finding</h2>
              {(data?.instances ?? []).length === 0 ? (
                <div className="text-[13px] text-stone-500">CDMSS sent no instance detail for this thread.</div>
              ) : (
                <ul className="space-y-3">
                  {(data?.instances ?? []).map((i, idx) => (
                    <li key={`${i.finding_ref ?? i.audit_id ?? idx}`} className="rounded-lg border border-stone-100 bg-stone-50 px-3 py-2.5">
                      <div className="text-[13px] font-medium text-stone-900">{i.subject ?? "Finding"}</div>
                      <div className="text-[11.5px] text-stone-500">
                        {i.note_date ? `Note of ${formatDay(i.note_date) || i.note_date}` : "Note date unknown"}
                        {i.verdict ? ` · ${i.verdict}` : ""}
                      </div>
                      {i.rationale ? <p className="mt-1 text-[12.5px] leading-snug text-stone-700">{i.rationale}</p> : null}
                      {i.citations.length > 0 ? (
                        <ul className="mt-1 text-[11.5px] text-stone-500">
                          {i.citations.map((c, ci) => (
                            <li key={ci}>
                              {c.n != null ? `[${c.n}] ` : ""}
                              {c.url ? <a href={c.url} target="_blank" rel="noreferrer" className="text-brand hover:underline">{c.title}</a> : c.title}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-xl border border-stone-200 bg-white px-5 py-4">
              <h2 className="mb-2 text-sm font-semibold">Doctor&apos;s response</h2>
              {t.response ? (
                <div className="text-[13px]">
                  <div className="font-medium text-stone-900">
                    {t.response.verb_text}
                    {t.response.at ? <span className="ml-2 text-[12px] font-normal text-stone-500">{formatDateTime(t.response.at)}</span> : null}
                  </div>
                  {t.response.comment ? <p className="mt-1 whitespace-pre-wrap text-stone-700">{t.response.comment}</p> : null}
                </div>
              ) : (
                <div className="text-[13px] text-stone-500">
                  {t.response_required === "none" ? "No response was asked for." : "The doctor has not responded yet."}
                </div>
              )}
              {t.ruling ? (
                <div className="mt-3 border-t border-stone-100 pt-3 text-[13px]">
                  <div className="font-medium text-stone-900">
                    Governance ruling: {t.ruling.action_text}
                    {t.ruling.ruled_at ? <span className="ml-2 text-[12px] font-normal text-stone-500">{formatDateTime(t.ruling.ruled_at)}</span> : null}
                  </div>
                  {t.ruling.note ? <p className="mt-1 whitespace-pre-wrap text-stone-700">{t.ruling.note}</p> : null}
                  {t.ruling.actor ? <div className="mt-0.5 text-[11.5px] text-stone-400">by {t.ruling.actor.replace(/^gov:/, "")}</div> : null}
                </div>
              ) : null}
            </section>

            <section className="rounded-xl border border-stone-200 bg-white px-5 py-4">
              <h2 className="mb-2 text-sm font-semibold">Timeline</h2>
              {(data?.timeline ?? []).length === 0 ? (
                <div className="text-[13px] text-stone-500">No events recorded.</div>
              ) : (
                <ol className="space-y-2.5">
                  {(data?.timeline ?? []).map((e, i) => (
                    <li key={i} className="border-l-2 border-stone-200 pl-3 text-[13px]">
                      <div className="text-stone-900">{e.text}</div>
                      {e.note ? <p className="mt-0.5 whitespace-pre-wrap text-[12.5px] text-stone-600">{e.note}</p> : null}
                      <div className="text-[11.5px] text-stone-400">
                        {e.actor}
                        {e.at ? ` · ${formatDateTime(e.at)}` : ""}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className="rounded-xl border border-stone-200 bg-white px-5 py-4">
              <h2 className="mb-2 text-sm font-semibold">Ruling</h2>
              {(data?.pending_rulings ?? []).length > 0 ? (
                <div role="status" className="mb-3 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-[12.5px] text-violet-950">
                  <span className="mr-1.5 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-700">Pending sync</span>
                  {(data?.pending_rulings ?? []).map((p) => actionLabel(p.action)).join(", ")} saved here, not yet confirmed by CDMSS. The
                  thread above still shows its old status. Press the same button to retry now; it is also retried every night and will not be
                  recorded twice.
                </div>
              ) : null}
              {data?.can_rule === false ? (
                <div className="text-[13px] text-stone-500">
                  Only a super admin, or a Site Medical Head for a doctor at their own hospital, can record a ruling.
                </div>
              ) : (data?.actions ?? []).length === 0 ? (
                <div className="text-[13px] text-stone-500">
                  {t.status === "closed" ? "This thread is closed. No further ruling is possible." : "No ruling is available for this thread."}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="space-y-2">
                    {(data?.actions ?? []).map((a) => (
                      <label
                        key={a.action}
                        className={
                          "flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 " +
                          (action === a.action ? "border-brand bg-brand-soft" : "border-stone-200 hover:bg-stone-50")
                        }
                      >
                        <input
                          type="radio"
                          name="ruling-action"
                          className="mt-1"
                          checked={action === a.action}
                          onChange={() => setAction(a.action)}
                        />
                        <span>
                          <span className="block text-[13px] font-semibold text-stone-900">{a.button}</span>
                          <span className="block text-[12px] text-stone-500">{a.help}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                  <div>
                    <label htmlFor="ruling-note" className="mb-1 block text-[12px] font-semibold text-stone-700">
                      Note (required)
                    </label>
                    <textarea
                      id="ruling-note"
                      className="w-full rounded-md border border-stone-200 px-3 py-2 text-[13px]"
                      rows={3}
                      maxLength={2000}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Why this ruling. This is kept with the decision."
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      disabled={!action || note.trim().length < NOTE_MIN || busy}
                      onClick={() => void submit()}
                      className="rounded-md bg-brand px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-40"
                    >
                      {busy ? "Recording…" : "Record ruling"}
                    </button>
                  </div>
                </div>
              )}
              {notice ? (
                <div
                  role="status"
                  className={
                    "mt-3 rounded-lg border px-3 py-2 text-[13px] " +
                    (notice.tone === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-950")
                  }
                >
                  {notice.text}
                </div>
              ) : null}
            </section>
          </div>
        )}
      </main>
    </>
  );
}
