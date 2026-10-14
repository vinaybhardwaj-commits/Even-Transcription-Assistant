import { DocumentAuditDetail } from "@/components/document-audits/DocumentAuditDetail";

export const dynamic = "force-dynamic";

export default function DocumentAuditDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { finding?: string | string[] };
}) {
  const finding = Array.isArray(searchParams.finding) ? searchParams.finding[0] : searchParams.finding;
  return <DocumentAuditDetail auditId={params.id} initialFinding={finding ?? null} />;
}
