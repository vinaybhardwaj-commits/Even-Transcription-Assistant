import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { StewardLogView } from "@/components/rooms-live/StewardLogView";
import { roomsLivePageGuard } from "@/lib/rooms-live/guard";
import { loadLogPage } from "@/lib/rooms-live/steward-log-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Steward log", robots: { index: false, follow: false } };

type Q = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | null => (typeof v === "string" ? v : null);

// Same access as /rooms-live: roomsLivePageGuard (open by owner ruling 8 Oct 2026). An unknown room is a 404; a bad ?date= shows today.
export default async function StewardRoomPage({ params, searchParams }: { params: Promise<{ room: string }>; searchParams: Promise<Q> }) {
  await roomsLivePageGuard();
  const { room } = await params;
  const q = await searchParams;
  const page = await loadLogPage(sql as never, { room, date: one(q.date), show: one(q.show), offset: one(q.offset) }, Date.now());
  if (page === "no_such_room") notFound();
  return <StewardLogView page={page} />;
}
