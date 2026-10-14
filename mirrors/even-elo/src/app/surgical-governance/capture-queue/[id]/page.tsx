import { notFound } from "next/navigation";
import { CaptureFlagOff } from "@/components/capture/CaptureFlagOff";
import { isOtCaptureEnabled } from "@/lib/capture/access";
import { isUuid } from "@/lib/capture/staff";
import { DetailClient } from "./DetailClient";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function CaptureDetailPage({ params }: { params: { id: string } }) {
  if (!isOtCaptureEnabled()) {
    return <CaptureFlagOff title="Capture" crumb="Capture queue" />;
  }
  if (!isUuid(params.id)) notFound();
  return <DetailClient id={params.id} />;
}
