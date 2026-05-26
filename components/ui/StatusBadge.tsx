import * as React from "react";

type Status = "sent" | "failed" | "queued" | "pending" | "deleted";

const statusClasses: Record<Status, string> = {
  sent: "bg-success-100 text-success-700",
  failed: "bg-danger-100 text-danger-700",
  queued: "bg-warning-100 text-warning-700",
  pending: "bg-ai-100 text-ai-700",
  deleted: "bg-even-ink-100 text-even-ink-500",
};

const statusIcon: Record<Status, string> = {
  sent: "\u2713",
  failed: "\u26A0",
  queued: "\u23F3",
  pending: "\u00B7\u00B7\u00B7",
  deleted: "\u00D7",
};

const statusLabel: Record<Status, string> = {
  sent: "Sent",
  failed: "Failed",
  queued: "Queued",
  pending: "Pending",
  deleted: "Deleted",
};

export function StatusBadge({ status, className = "" }: { status: Status; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-caption font-medium ${statusClasses[status]} ${className}`}
    >
      <span aria-hidden="true">{statusIcon[status]}</span>
      <span>{statusLabel[status]}</span>
    </span>
  );
}
