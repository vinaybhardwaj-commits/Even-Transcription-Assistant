"use client";

import Link from "next/link";
import { pendingRulingText, syncFlagText, type FindingRow } from "@/lib/audit-findings";

/** "2026-10-08T05:30:00Z" -> "8 Oct 2026". Empty for a missing or unreadable date. */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}

/** "2026-10-08T05:30:00Z" -> "8 Oct 2026, 11:00 am" (IST). */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

const VERB_TONE: Record<string, string> = {
  agree: "bg-emerald-50 text-emerald-800",
  disagree: "bg-rose-50 text-rose-800",
  needs_clarification: "bg-amber-50 text-amber-800",
};

export function StatusChips({ row }: { row: FindingRow }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {row.overdue ? (
        <span className="rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-700">Overdue</span>
      ) : null}
      {row.awaiting_ruling ? (
        <span className="rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-700">
          Awaiting ruling
        </span>
      ) : null}
      {row.pending_ruling ? (
        <span
          title={pendingRulingText(row.pending_ruling)}
          className="rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-700"
        >
          Pending sync
        </span>
      ) : null}
      {row.sync ? (
        <span
          title={syncFlagText(row.sync)}
          className={
            "rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide " +
            (row.sync.permanent ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-800")
          }
        >
          Not yet synced
        </span>
      ) : null}
    </div>
  );
}

/**
 * The thread table shared by the worklist and the physician profile section. Columns: doctor (worklist
 * only), finding type, note type, routed date, status in words with the overdue and awaiting-ruling
 * flags, the doctor's response (verb plus a short comment), and a link to the thread.
 */
export function FindingsTable({ rows, showDoctor }: { rows: FindingRow[]; showDoctor: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="border-b border-stone-200 text-left text-[10.5px] uppercase tracking-wide text-stone-400">
            {showDoctor ? <th className="py-2 pr-3">Doctor</th> : null}
            <th className="py-2 pr-3">Finding</th>
            <th className="py-2 pr-3">Note type</th>
            <th className="py-2 pr-3">Routed</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3">Doctor&apos;s response</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.reference} className="border-b border-stone-50 align-top">
              {showDoctor ? (
                <td className="py-2 pr-3 font-medium text-stone-900">
                  {r.physician_id ? (
                    <Link href={`/physicians/${r.physician_id}`} className="text-brand hover:underline">
                      {r.doctor_name ?? r.doctor_uid}
                    </Link>
                  ) : (
                    <span title="Not linked to a physician profile yet">{r.doctor_name ?? r.doctor_uid}</span>
                  )}
                </td>
              ) : null}
              <td className="py-2 pr-3">
                <div className="font-medium text-stone-900">{r.finding_type}</div>
                <div className="text-[11px] text-stone-400">{r.reference}</div>
              </td>
              <td className="py-2 pr-3 text-stone-600">{r.note_type}</td>
              <td className="py-2 pr-3 whitespace-nowrap text-stone-600">{formatDay(r.routed_at) || "—"}</td>
              <td className="py-2 pr-3">
                <div className="text-stone-800">{r.status_text}</div>
                <StatusChips row={r} />
              </td>
              <td className="py-2 pr-3">
                {r.response ? (
                  <div>
                    <span
                      className={
                        "rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold " +
                        (r.response.verb ? VERB_TONE[r.response.verb] : "bg-stone-100 text-stone-700")
                      }
                    >
                      {r.response.verb_text}
                    </span>
                    {r.response.comment_short ? <div className="mt-1 max-w-[260px] text-stone-600">{r.response.comment_short}</div> : null}
                  </div>
                ) : (
                  <span className="text-stone-400">{r.response_required === "none" ? "Not required" : "None yet"}</span>
                )}
              </td>
              <td className="py-2 text-right">
                <Link href={`/audit-findings/${encodeURIComponent(r.reference)}`} className="whitespace-nowrap text-[12px] font-semibold text-brand hover:underline">
                  Open →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
