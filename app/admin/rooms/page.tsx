/**
 * /admin/rooms - every room, its most recent room-day and a count of days.
 *
 * S1 (ETA-S1-ROOM-DAY-TAPE-SPEC-v1.0 section 4). Thin server component: auth, then AdminShell wrapping
 * the client component. Data is fetched here (server-side) and passed down as props, not through
 * a client-side API call - this route has no API endpoint of its own; the one API route this
 * build adds is the tape's (section 9's allowed-file list).
 */
import { redirect } from "next/navigation";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { RoomsListClient } from "@/components/admin/rooms/RoomsListClient";
import { listRoomsOverview } from "@/lib/room-day/admin";

export const dynamic = "force-dynamic";

export default async function AdminRoomsPage() {
  const cookie = await readAdminCookie();
  if (!cookie) redirect("/admin");
  let email = "";
  try {
    email = String((await verifyAdminJwt(cookie)).email ?? "");
  } catch {
    redirect("/admin");
  }

  const rooms = await listRoomsOverview();

  return (
    <AdminShell adminEmail={email} active="rooms" pageTitle="Rooms">
      <RoomsListClient rooms={rooms} />
    </AdminShell>
  );
}
