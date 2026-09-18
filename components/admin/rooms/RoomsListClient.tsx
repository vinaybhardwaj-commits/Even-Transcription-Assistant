"use client";

import Link from "next/link";
import type { RoomOverviewRow } from "@/lib/room-day/admin";

/**
 * `/admin/rooms` - every room, its most recent room-day and a count of days (S1 section 4).
 */
export function RoomsListClient({ rooms }: { rooms: RoomOverviewRow[] }) {
  if (rooms.length === 0) {
    return <p className="text-caption text-even-ink-500 p-4">No rooms yet.</p>;
  }
  return (
    <div className="bg-even-white rounded-xl border border-even-ink-200 overflow-hidden">
      <table className="w-full text-caption">
        <thead className="bg-even-ink-50 text-even-navy-800/60 text-left">
          <tr>
            <th className="px-4 py-2 font-medium">Room</th>
            <th className="px-4 py-2 font-medium">Slug</th>
            <th className="px-4 py-2 font-medium">Most recent day</th>
            <th className="px-4 py-2 font-medium">Days</th>
          </tr>
        </thead>
        <tbody>
          {rooms.map((r) => (
            <tr key={r.id} className="border-t border-even-ink-100">
              <td className="px-4 py-2">
                <Link href={`/admin/rooms/${r.id}`} className="text-even-blue-600 hover:underline font-medium">
                  {r.name}
                </Link>
                {r.disabled_at ? <span className="ml-2 text-[10px] uppercase text-even-ink-500">disabled</span> : null}
              </td>
              <td className="px-4 py-2 text-even-ink-500">{r.slug}</td>
              <td className="px-4 py-2">
                {r.latest_ist_date ? (
                  <Link href={`/admin/rooms/${r.id}/${r.latest_ist_date}`} className="text-even-blue-600 hover:underline">
                    {r.latest_ist_date}
                  </Link>
                ) : (
                  <span className="text-even-ink-500">no tape yet</span>
                )}
              </td>
              <td className="px-4 py-2">{r.day_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
