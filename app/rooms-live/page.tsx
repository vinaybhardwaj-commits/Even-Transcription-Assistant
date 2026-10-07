import RoomsLiveClient from "@/components/rooms-live/RoomsLiveClient";
import { roomsLivePageGuard } from "@/lib/rooms-live/guard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Rooms Live", robots: { index: false, follow: false } };

// Open by owner ruling 8 Oct 2026: no login screen, no PIN. (LoginScreen and the login/logout routes stay in the tree, unused by this page.)
export default async function RoomsLivePage() {
  const who = await roomsLivePageGuard();
  return <RoomsLiveClient who={who} />;
}
