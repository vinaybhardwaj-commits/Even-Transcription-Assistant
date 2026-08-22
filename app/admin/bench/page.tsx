import { redirect } from "next/navigation";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { BenchClient } from "@/components/admin/BenchClient";
import { BenchRoomsLive } from "@/components/admin/BenchRoomsLive";

/**
 * Admin · Bench — room recording sessions + Rooms card (Room-Bench PRD §3.5;
 * mockup screens 4 & 6). Lives under the observe section with Diarization
 * and STT Lab. Rooms are managed HERE, never on the Clinicians page (D5).
 */

export const dynamic = "force-dynamic";

export default async function AdminBenchPage() {
  const cookie = await readAdminCookie();
  if (!cookie) redirect("/admin");
  let email = "";
  try {
    email = String((await verifyAdminJwt(cookie)).email ?? "");
  } catch {
    redirect("/admin");
  }
  return (
    <AdminShell adminEmail={email} active="bench" pageTitle="Bench — room recording sessions">
      {/* The live monitor sits ABOVE the session table: on a clinic day the question is always
          "what is wrong right now", and the day's history is what you read afterwards. */}
      <BenchRoomsLive />
      <BenchClient />
    </AdminShell>
  );
}
