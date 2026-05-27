"use client";

import * as React from "react";
import { Button } from "@/components/ui/Button";

export type SendEventLite = {
  id: string;
  recipient_email: string;
  status: string;
  subject: string;
  created_at: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Props = {
  doctorEmail: string;
  doctorName: string;
  sendEvents: SendEventLite[];
  sendStatus: "pending" | "sent" | "failed";
  onSend: (recipients: string[]) => Promise<{ ok: boolean; error?: string }>;
};

export function SendPanel({
  doctorEmail,
  doctorName,
  sendEvents,
  sendStatus,
  onSend,
}: Props) {
  // Track which addresses are checked; doctor is checked by default.
  const [checked, setChecked] = React.useState<Record<string, boolean>>({
    [doctorEmail.toLowerCase()]: true,
  });
  const [extras, setExtras] = React.useState<string[]>([]); // user-added beyond doctor
  const [pendingInput, setPendingInput] = React.useState("");
  const [inputError, setInputError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);

  const recipientList = React.useMemo(
    () => [doctorEmail.toLowerCase(), ...extras],
    [doctorEmail, extras],
  );
  const selected = React.useMemo(
    () => recipientList.filter((e) => checked[e]),
    [recipientList, checked],
  );

  const addRecipient = React.useCallback(() => {
    const v = pendingInput.trim().toLowerCase();
    if (!v) return;
    if (!EMAIL_RE.test(v)) {
      setInputError("That doesn't look like a valid email address.");
      return;
    }
    if (recipientList.includes(v)) {
      setInputError("Already in the list.");
      return;
    }
    setExtras((prev) => [...prev, v]);
    setChecked((prev) => ({ ...prev, [v]: true }));
    setPendingInput("");
    setInputError(null);
  }, [pendingInput, recipientList]);

  const removeExtra = React.useCallback((email: string) => {
    setExtras((prev) => prev.filter((e) => e !== email));
    setChecked((prev) => {
      const next = { ...prev };
      delete next[email];
      return next;
    });
  }, []);

  const handleSend = React.useCallback(async () => {
    if (selected.length === 0) {
      setSendError("Select at least one recipient.");
      return;
    }
    setSending(true);
    setSendError(null);
    const r = await onSend(selected);
    setSending(false);
    if (!r.ok) {
      setSendError(r.error ?? "Send failed");
    } else {
      // Clear extras after a successful send so the form is "fresh"
      setExtras([]);
      setPendingInput("");
    }
  }, [selected, onSend]);

  return (
    <section className="rounded-xl border border-even-ink-100 bg-even-white p-5 shadow-card space-y-4">
      <div>
        <h3 className="text-heading text-even-navy-800">Send</h3>
        <p className="text-caption text-even-ink-500 mt-0.5">
          Email this note to yourself and anyone else who needs it.
        </p>
      </div>

      <ul className="space-y-2">
        {recipientList.map((email) => {
          const isYou = email === doctorEmail.toLowerCase();
          const isChecked = !!checked[email];
          return (
            <li
              key={email}
              className="flex items-center justify-between gap-3 rounded-md border border-even-ink-100 px-3 py-2"
            >
              <label className="flex items-center gap-3 min-w-0 flex-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={(e) =>
                    setChecked((prev) => ({ ...prev, [email]: e.target.checked }))
                  }
                  className="h-4 w-4 accent-even-blue-600"
                />
                <span className="min-w-0">
                  <span className="block text-body text-even-navy-800 truncate">
                    {email}
                    {isYou ? (
                      <span className="ml-2 text-caption text-even-ink-500">
                        (You · {doctorName.replace(/^Dr\.?\s+/i, "")})
                      </span>
                    ) : null}
                  </span>
                </span>
              </label>
              {!isYou ? (
                <button
                  type="button"
                  onClick={() => removeExtra(email)}
                  className="text-caption text-even-ink-400 hover:text-danger-700 px-1"
                  aria-label={`Remove ${email}`}
                >
                  Remove
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div>
        <div className="flex gap-2">
          <input
            type="email"
            value={pendingInput}
            placeholder="Add another email address"
            onChange={(e) => {
              setPendingInput(e.target.value);
              setInputError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addRecipient();
              }
            }}
            autoComplete="email"
            className="flex-1 rounded-md border border-even-ink-200 px-3 py-2 text-body text-even-ink-800 focus:outline-none focus:ring-2 focus:ring-even-blue-300"
          />
          <Button variant="secondary" onClick={addRecipient}>
            Add
          </Button>
        </div>
        {inputError ? (
          <p className="mt-1 text-caption text-danger-700">{inputError}</p>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3 pt-2">
        <p className="text-caption text-even-ink-500">
          {selected.length} recipient{selected.length === 1 ? "" : "s"} selected
        </p>
        <Button
          variant="primary"
          size="lg"
          onClick={handleSend}
          disabled={sending || selected.length === 0}
        >
          {sending ? "Sending…" : sendStatus === "sent" ? "Send again" : "Send now"}
        </Button>
      </div>

      {sendError ? (
        <p className="text-caption text-danger-700 text-right">{sendError}</p>
      ) : null}

      {sendEvents.length > 0 ? (
        <div className="pt-2 border-t border-even-ink-100">
          <p className="text-caption text-even-ink-500 mb-2">Send history</p>
          <ul className="space-y-1.5">
            {sendEvents.map((e) => (
              <li key={e.id} className="flex items-center justify-between text-body">
                <span className="text-even-ink-800 truncate">{e.recipient_email}</span>
                <span className="text-caption text-even-ink-500">
                  <StatusDot status={e.status} />
                  <span className="ml-1 capitalize">{e.status}</span>
                  <span className="ml-2 text-even-ink-400">
                    {new Date(e.created_at).toLocaleTimeString("en-IN", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "sent" || status === "delivered" || status === "opened"
      ? "bg-success-500"
      : status === "queued"
      ? "bg-even-blue-500"
      : status === "bounced" || status === "complained" || status === "failed"
      ? "bg-danger-500"
      : "bg-even-ink-300";
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full align-middle ${color}`}
      aria-hidden="true"
    />
  );
}
