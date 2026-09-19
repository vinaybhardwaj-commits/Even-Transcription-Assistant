/**
 * /admin/rooms/[roomId]/[date] - the tape.
 *
 * S1 (ETA-S1-ROOM-DAY-TAPE-SPEC-v1.0 section 4). `[date]` is the IST date as YYYY-MM-DD, never a
 * room_day_id - UNIQUE(room_id, ist_date) makes it unambiguous and V can type it. Thin server
 * component: auth only. The client component fetches its own bundle from the one API route this
 * build adds (app/api/admin/rooms/[roomId]/days/[date]/route.ts) - the house pattern
 * (components/admin/EncounterDetailAdminClient.tsx:200-295).
 */
import { redirect } from "next/navigation";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { RoomDayTapeClient } from "@/components/admin/rooms/RoomDayTapeClient";

export const dynamic = "force-dynamic";

export default async function AdminRoomDayTapePage({ params }: { params: Promise<{ roomId: string; date: string }> }) {
  const cookie = await readAdminCookie();
  if (!cookie) redirect("/admin");
  let email = "";
  try {
    email = String((await verifyAdminJwt(cookie)).email ?? "");
  } catch {
    redirect("/admin");
  }

  const { roomId, date } = await params;

  return (
    <AdminShell adminEmail={email} active="rooms" pageTitle={date} breadcrumb="Rooms">
      <RoomDayTapeClient roomId={roomId} istDate={date} />
    </AdminShell>
  );
}
