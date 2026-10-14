import { CaptureFlagOff } from "@/components/capture/CaptureFlagOff";
import { isOtCaptureEnabled } from "@/lib/capture/access";
import { QueueClient } from "./QueueClient";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function CaptureQueuePage() {
  if (!isOtCaptureEnabled()) {
    return <CaptureFlagOff title="Capture queue" crumb="Capture queue" />;
  }
  return <QueueClient />;
}
