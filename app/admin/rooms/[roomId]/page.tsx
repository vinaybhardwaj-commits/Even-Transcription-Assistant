/**
 * /admin/rooms/[roomId] - one room's days, newest first.
 *
 * S1 (ETA-S1-ROOM-DAY-TAPE-SPEC-v1.0 section 4). Thin server component; data fetched server-side and
 * passed down as props, for the same reason as the rooms list page above it.
 */
import { redirect, notFound } from "next/navigation";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { RoomDaysClient } from "@/components/admin/rooms/RoomDaysClient";
import { listRoomDays } from "@/lib/room-day/admin";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function AdminRoomDetailPage({ params }: { params: Promise<{ roomId: string }> }) {
  const cookie = await readAdminCookie();
  if (!cookie) redirect("/admin");
  let email = "";
  try {
    email = String((await verifyAdminJwt(cookie)).email ?? "");
  } catch {
    redirect("/admin");
  }

  const { roomId } = await params;
  const roomRows = (await sql`SELECT id, slug, name FROM room WHERE id = ${roomId} LIMIT 1`) as Array<{
    id: string;
    slug: string;
    name: string;
  }>;
  const room = roomRows[0];
  if (!room) notFound();

  const days = await listRoomDays(roomId);

  return (
    <AdminShell adminEmail={email} active="rooms" pageTitle={room.name} breadcrumb="Rooms">
      <RoomDaysClient room={room} days={days} />
    </AdminShell>
  );
}
