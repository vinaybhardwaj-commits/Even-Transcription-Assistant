import { ThreadDetail } from "@/components/audit-findings/ThreadDetail";

export const dynamic = "force-dynamic";

export default function AuditFindingThreadPage({ params }: { params: { reference: string } }) {
  return <ThreadDetail reference={decodeURIComponent(params.reference)} />;
}
