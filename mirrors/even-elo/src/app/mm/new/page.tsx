import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AdminShell } from "@/components/AdminShell";
import MmNewCaseClient from "@/components/mm/MmNewCaseClient";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function Page() {
  // SGC predicate, re-stated per page (decision 13).
  const u = await getCurrentUser();
  if (!u || u.status !== "active" || !(u.is_super_admin || u.is_sgc_member)) redirect("/home");
  return (
    <AdminShell
      breadcrumbs={[{ label: "Governance", href: "/overview" }, { label: "M&M", href: "/mm" }, { label: "New case" }]}
      title="New M&M case"
      subtitle="Incident-optional seeding (decision 9) · operator-confirmed identity match (FR-1.8)"
    >
      <MmNewCaseClient />
    </AdminShell>
  );
}
