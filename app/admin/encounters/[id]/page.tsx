/**
 * /admin/encounters/{id} — admin Encounter detail page (Sprint 7).
 *
 * Server component. Authenticates the admin cookie; delegates the heavy
 * lifting (hero / pipeline trace / 5 tabs / right rail / resend / delete)
 * to EncounterDetailAdminClient.
 *
 * ENC: this page shows NO isolation sections. The id here is an `encounter` row id (enc_<nanoid>), and the
 * `encounter` table has no column that holds the Pulse consult uid, so enc_isolation cannot be looked up from
 * here without inventing a link. The Isolation / Parts / Rx check sections render on
 * /admin/rooms/[roomId]/[date]#consult-<uid> instead. (Flag in the ENC-W1 report.)
 */
import { redirect } from "next/navigation";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { EncounterDetailAdminClient } from "@/components/admin/EncounterDetailAdminClient";

export const dynamic = "force-dynamic";

export default async function AdminEncounterDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const cookie = await readAdminCookie();
  if (!cookie) redirect("/admin");
  let email = "";
  try {
    const claims = await verifyAdminJwt(cookie);
    email = String(claims.email ?? "");
  } catch {
    redirect("/admin");
  }

  const { id } = await params;

  return (
    <AdminShell
      adminEmail={email}
      active="encounters"
      pageTitle={id}
      breadcrumb="Encounters"
    >
      <EncounterDetailAdminClient encounterId={id} />
    </AdminShell>
  );
}
