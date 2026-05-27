/**
 * /admin/encounters — cross-doctor encounter log (Sprint 8).
 *
 * Server component. Authenticates admin cookie; delegates to client.
 */
import { redirect } from "next/navigation";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { EncountersListClient } from "@/components/admin/EncountersListClient";

export const dynamic = "force-dynamic";

export default async function AdminEncountersPage() {
  const cookie = await readAdminCookie();
  if (!cookie) redirect("/admin");
  let email = "";
  try {
    const claims = await verifyAdminJwt(cookie);
    email = String(claims.email ?? "");
  } catch {
    redirect("/admin");
  }

  return (
    <AdminShell adminEmail={email} active="encounters" pageTitle="Encounters">
      <EncountersListClient />
    </AdminShell>
  );
}
