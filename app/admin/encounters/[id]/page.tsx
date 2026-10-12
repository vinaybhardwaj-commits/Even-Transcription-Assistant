/**
 * /admin/encounters/{id} — admin Encounter detail page (Sprint 7).
 *
 * Server component. Authenticates the admin cookie; delegates the heavy
 * lifting (hero / pipeline trace / 5 tabs / right rail / resend / delete)
 * to EncounterDetailAdminClient. ENC-W2 adds the Isolation / Parts / Rx check sections above it,
 * read from enc_isolation by this id (renders nothing when there is no row).
 */
import { redirect } from "next/navigation";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { EncounterDetailAdminClient } from "@/components/admin/EncounterDetailAdminClient";
import { EncIsolationSections } from "@/components/admin/enc/EncIsolationSections";
import { getIsolation } from "@/lib/enc/queries";

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
  const iso = await getIsolation(id);

  return (
    <AdminShell
      adminEmail={email}
      active="encounters"
      pageTitle={id}
      breadcrumb="Encounters"
    >
      <EncIsolationSections iso={iso} />
      <EncounterDetailAdminClient encounterId={id} />
    </AdminShell>
  );
}
