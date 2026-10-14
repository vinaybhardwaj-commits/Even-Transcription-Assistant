import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AdminShell } from "@/components/AdminShell";
import MmCaseClient from "@/components/mm/MmCaseClient";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function Page() {
  // SGC predicate, re-stated per page (decision 13). This page renders PHI.
  const u = await getCurrentUser();
  if (!u || u.status !== "active" || !(u.is_super_admin || u.is_sgc_member)) redirect("/home");
  return (
    <AdminShell
      breadcrumbs={[{ label: "Governance", href: "/overview" }, { label: "M&M", href: "/mm" }, { label: "Case" }]}
      title="M&M case"
    >
      <MmCaseClient />
    </AdminShell>
  );
}
