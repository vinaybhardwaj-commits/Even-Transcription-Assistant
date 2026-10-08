import { sql } from "@/lib/db";
import { StewardLogView } from "@/components/rooms-live/StewardLogView";
import { roomsLivePageGuard } from "@/lib/rooms-live/guard";
import { loadLogPage } from "@/lib/rooms-live/steward-log-page";
import { notFound, redirect } from "next/navigation";

export const dynamic = "force-dynamic";
export const metadata = { title: "All Steward logs", robots: { index: false, follow: false } };

type Q = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | null => (typeof v === "string" ? v : null);

// S8: every room, with a ?room= filter. A ?room= on the roster redirects to that room's page; one that is not on the roster is ignored (all rooms), not an error.
export default async function StewardAllPage({ searchParams }: { searchParams: Promise<Q> }) {
  await roomsLivePageGuard();
  const q = await searchParams;
  const base = { date: one(q.date), show: one(q.show), offset: one(q.offset) };
  const wanted = one(q.room);
  if (wanted) {
    // a room filter is the per-room page; an unknown room falls through to all rooms
    const one_room = await loadLogPage(sql as never, { ...base, room: wanted }, Date.now());
    if (one_room !== "no_such_room") {
      const qs = new URLSearchParams();
      for (const k of ["date", "show"] as const) if (base[k]) qs.set(k, base[k]!);
      redirect(`/rooms-live/steward/${one_room.room!.room_id}${qs.toString() ? `?${qs}` : ""}`);
    }
  }
  const page = await loadLogPage(sql as never, { ...base, room: null }, Date.now());
  if (page === "no_such_room") notFound();
  return <StewardLogView page={page} />;
}
