import RoomsLiveClient from "@/components/rooms-live/RoomsLiveClient";
import LoginScreen from "@/components/rooms-live/LoginScreen";
import { roomsLivePageGuard } from "@/lib/rooms-live/guard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Rooms Live" };

export default async function RoomsLivePage() {
  const who = await roomsLivePageGuard();
  if (!who) return <LoginScreen />;
  return <RoomsLiveClient who={who} />;
}
