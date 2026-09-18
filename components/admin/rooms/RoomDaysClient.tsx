"use client";

import Link from "next/link";
import type { RoomDayOverviewRow } from "@/lib/room-day/admin";

/**
 * `/admin/rooms/[roomId]` - one room's days, newest first (S1 section 4).
 */
export function RoomDaysClient({
  room,
  days,
}: {
  room: { id: string; slug: string; name: string };
  days: RoomDayOverviewRow[];
}) {
  if (days.length === 0) {
    return <p className="text-caption text-even-ink-500 p-4">No days recorded for {room.name} yet.</p>;
  }
  return (
    <div className="bg-even-white rounded-xl border border-even-ink-200 overflow-hidden">
      <table className="w-full text-caption">
        <thead className="bg-even-ink-50 text-even-navy-800/60 text-left">
          <tr>
            <th className="px-4 py-2 font-medium">Date</th>
            <th className="px-4 py-2 font-medium">Windows</th>
            <th className="px-4 py-2 font-medium">Transcribed</th>
            <th className="px-4 py-2 font-medium">Turns</th>
            <th className="px-4 py-2 font-medium">Voice match</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.ist_date} className="border-t border-even-ink-100">
              <td className="px-4 py-2">
                <Link href={`/admin/rooms/${room.id}/${d.ist_date}`} className="text-even-blue-600 hover:underline font-medium">
                  {d.ist_date}
                </Link>
                {!d.room_day_id ? <span className="ml-2 text-[10px] uppercase text-even-ink-500">no room_day row</span> : null}
              </td>
              <td className="px-4 py-2">{d.window_count}</td>
              <td className="px-4 py-2">{d.transcribed_count}</td>
              <td className="px-4 py-2">{d.turn_count}</td>
              <td className="px-4 py-2">{d.any_voice_match ? "yes" : "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
