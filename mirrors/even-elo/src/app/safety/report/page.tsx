import { redirect } from "next/navigation";
import { AdminShell } from "@/components/AdminShell";
import SafetyNav from "@/components/safety/SafetyNav";
import { getCurrentUser } from "@/lib/auth";
import IncidentReporter from "./IncidentReporter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function Page() {
  const user = await getCurrentUser();
  if (!user || user.status !== "active" || !(user.is_super_admin || user.is_sgc_member)) {
    redirect("/home");
  }

  return (
    <AdminShell
      breadcrumbs={[
        { label: "Governance", href: "/overview" },
        { label: "Incidents", href: "/safety" },
        { label: "Report" },
      ]}
      title="Report an incident"
      subtitle="File a clinical or operational incident directly with the hospital safety team."
    >
      <SafetyNav />
      <IncidentReporter reporterName={user.full_name || ""} reporterEmail={user.email || ""} />
    </AdminShell>
  );
}
