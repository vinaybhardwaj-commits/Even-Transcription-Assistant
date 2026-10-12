"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { STATUS_CHIP, type CoverageRow } from "@/lib/enc/view";

/**
 * `/admin/rooms?tab=coverage&date=YYYY-MM-DD` - the ENC "Daily coverage" tab (contract UI item 1).
 * Props only: the server page reads enc_room_day and joins room names. The table scrolls sideways on a phone.
 */
export function StatusChip({ status }: { status: keyof typeof STATUS_CHIP }) {
  const c = STATUS_CHIP[status];
  return <span className={`text-[11px] px-2 py-0.5 rounded-full border whitespace-nowrap ${c.cls}`}>{c.label}</span>;
}

export function DailyCoverageClient({ date, rows }: { date: string; rows: CoverageRow[] }) {
  const router = useRouter();
  const onDate = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) router.push(`/admin/rooms?tab=coverage&date=${v}`);
  };
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-caption text-even-navy-800">
        <span>Date (IST)</span>
        <input
          type="date"
          value={date}
          onChange={onDate}
          aria-label="Coverage date"
          className="min-h-11 px-3 rounded-lg border border-even-ink-200 bg-even-white text-even-navy-800"
        />
      </label>
      {rows.length === 0 ? (
        <p className="text-caption text-even-ink-500 p-4">No rooms yet.</p>
      ) : (
        <div className="bg-even-white rounded-xl border border-even-ink-200 overflow-x-auto">
          <table className="w-full text-caption min-w-[640px]">
            <thead className="bg-even-ink-50 text-even-navy-800/60 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">Room</th>
                <th className="px-3 py-2 font-medium">Visits</th>
                <th className="px-3 py-2 font-medium">Placed</th>
                <th className="px-3 py-2 font-medium">Isolated</th>
                <th className="px-3 py-2 font-medium">Processed</th>
                <th className="px-3 py-2 font-medium">Rx matched</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Top alert</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.room_id} className="border-t border-even-ink-100">
                  <td className="px-3 py-2">
                    <Link href={`/admin/rooms/${r.room_id}/${date}`} className="text-even-blue-600 hover:underline font-medium">
                      {r.room_name}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{r.has_data ? r.visits : "-"}</td>
                  <td className="px-3 py-2">{r.has_data ? r.placed : "-"}</td>
                  <td className="px-3 py-2">{r.has_data ? r.isolated : "-"}</td>
                  <td className="px-3 py-2">{r.has_data ? r.processed : "-"}</td>
                  <td className="px-3 py-2">{r.has_data ? r.rx_matched : "-"}</td>
                  <td className="px-3 py-2"><StatusChip status={r.status} /></td>
                  <td className="px-3 py-2 text-even-ink-500">{r.top_alert ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
