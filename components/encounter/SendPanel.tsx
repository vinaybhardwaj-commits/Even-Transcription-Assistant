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

type SavedRecipient = {
  id: string;
  email: string;
  name: string;
  role: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Props = {
  slug: string;
  doctorEmail: string;
  doctorName: string;
  sendEvents: SendEventLite[];
  sendStatus: "pending" | "sent" | "failed";
  onSend: (recipients: string[]) => Promise<{ ok: boolean; error?: string }>;
};

export function SendPanel({
  slug,
  doctorEmail,
  doctorName,
  sendEvents,
  sendStatus,
  onSend,
}: Props) {
  const [saved, setSaved] = React.useState<SavedRecipient[]>([]);
  const [savedLoaded, setSavedLoaded] = React.useState(false);

  // Track which addresses are checked. Doctor checked by default.
  const [checked, setChecked] = React.useState<Record<string, boolean>>({
    [doctorEmail.toLowerCase()]: true,
  });
  const [extras, setExtras] = React.useState<string[]>([]);
  const [pendingInput, setPendingInput] = React.useState("");
  const [inputError, setInputError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);

  const [globals, setGlobals] = React.useState<SavedRecipient[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [pRes, gRes] = await Promise.all([
          fetch(`/${slug}/api/recipients`, { cache: "no-store" }),
          fetch(`/${slug}/api/recipients/global`, { cache: "no-store" }),
        ]);
        const pJson = pRes.ok ? ((await pRes.json()) as { recipients: SavedRecipient[] }) : { recipients: [] };
        const gJson = gRes.ok ? ((await gRes.json()) as { recipients: SavedRecipient[] }) : { recipients: [] };
        if (!cancelled) {
          setSaved(pJson.recipients);
          setGlobals(gJson.recipients);
          setSavedLoaded(true);
          // Auto-check active globals (org default — admin curated)
          setChecked((prev) => {
            const next = { ...prev };
            for (const g of gJson.recipients) next[g.email.toLowerCase()] = true;
            return next;
          });
        }
      } catch {
        if (!cancelled) setSavedLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const allEmails = React.useMemo(
    () => [
      doctorEmail.toLowerCase(),
      ...globals.map((r) => r.email.toLowerCase()),
      ...saved.map((r) => r.email.toLowerCase()),
      ...extras,
    ],
    [doctorEmail, globals, saved, extras],
  );
  const selected = React.useMemo(
    () => Array.from(new Set(allEmails.filter((e) => checked[e]))),
    [allEmails, checked],
  );

  const addExtra = React.useCallback(() => {
    const v = pendingInput.trim().toLowerCase();
    if (!v) return;
    if (!EMAIL_RE.test(v)) {
      setInputError("That doesn't look like a valid email address.");
      return;
    }
    if (allEmails.includes(v)) {
      setInputError("Already in the list.");
      return;
    }
    setExtras((prev) => [...prev, v]);
    setChecked((prev) => ({ ...prev, [v]: true }));
    setPendingInput("");
    setInputError(null);
  }, [pendingInput, allEmails]);

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
      setExtras([]);
      setPendingInput("");
    }
  }, [selected, onSend]);

  return (
    <section className="rounded-xl border border-even-ink-100 bg-even-white p-5 shadow-card space-y-4">
      <div>
        <h3 className="text-heading text-even-navy-800">Send</h3>
        <p className="text-caption text-even-ink-500 mt-0.5">
          Email this note to yourself and anyone else who needs it.{" "}
          <a href={`/${slug}/recipients`} className="text-even-blue-600 hover:underline">
            Manage contacts
          </a>
        </p>
      </div>

      <ul className="space-y-2">
        {/* Doctor row */}
        <li className="flex items-center justify-between gap-3 rounded-md border border-even-ink-100 px-3 py-2">
          <label className="flex items-center gap-3 min-w-0 flex-1 cursor-pointer">
            <input
              type="checkbox"
              checked={!!checked[doctorEmail.toLowerCase()]}
              onChange={(e) =>
                setChecked((prev) => ({
                  ...prev,
                  [doctorEmail.toLowerCase()]: e.target.checked,
                }))
              }
              className="h-4 w-4 accent-even-blue-600"
            />
            <span className="block text-body text-even-navy-800 truncate">
              {doctorEmail}
              <span className="ml-2 text-caption text-even-ink-500">
                (You · {doctorName.replace(/^Dr\.?\s+/i, "")})
              </span>
            </span>
          </label>
        </li>

        {/* Global contacts (admin-curated) */}
        {globals.length > 0 ? (
          <li className="text-caption text-even-ink-500 px-1 pt-1">Hospital-wide contacts</li>
        ) : null}
        {globals.map((r) => {
          const e = r.email.toLowerCase();
          return (
            <li key={`g-${r.id}`}
              className="flex items-center justify-between gap-3 rounded-md border border-ai-200 bg-ai-50/40 px-3 py-2">
              <label className="flex items-center gap-3 min-w-0 flex-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!checked[e]}
                  onChange={(ev) =>
                    setChecked((prev) => ({ ...prev, [e]: ev.target.checked }))
                  }
                  className="h-4 w-4 accent-even-blue-600"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-body text-even-navy-800 truncate">
                    {r.name}
                  </span>
                  <span className="block text-caption text-even-ink-500 truncate">
                    {r.email}
                  </span>
                </span>
                <span className="text-caption rounded-full px-2 py-0.5 bg-ai-200 text-ai-700 shrink-0">
                  {r.role}
                </span>
              </label>
            </li>
          );
        })}

        {/* Saved contacts (personal) */}
        {saved.length > 0 && globals.length > 0 ? (
          <li className="text-caption text-even-ink-500 px-1 pt-2">Your contacts</li>
        ) : null}
        {saved.map((r) => {
          const e = r.email.toLowerCase();
          return (
            <li
              key={r.id}
              className="flex items-center justify-between gap-3 rounded-md border border-even-ink-100 px-3 py-2"
            >
              <label className="flex items-center gap-3 min-w-0 flex-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!checked[e]}
                  onChange={(ev) =>
                    setChecked((prev) => ({ ...prev, [e]: ev.target.checked }))
                  }
                  className="h-4 w-4 accent-even-blue-600"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-body text-even-navy-800 truncate">
                    {r.name}
                  </span>
                  <span className="block text-caption text-even-ink-500 truncate">
                    {r.email}
                  </span>
                </span>
                <span className="text-caption rounded-full px-2 py-0.5 bg-even-ink-100 text-even-ink-700 shrink-0">
                  {r.role}
                </span>
              </label>
            </li>
          );
        })}

        {/* Ad-hoc extras */}
        {extras.map((email) => (
          <li
            key={email}
            className="flex items-center justify-between gap-3 rounded-md border border-even-ink-100 px-3 py-2"
          >
            <label className="flex items-center gap-3 min-w-0 flex-1 cursor-pointer">
              <input
                type="checkbox"
                checked={!!checked[email]}
                onChange={(e) =>
                  setChecked((prev) => ({ ...prev, [email]: e.target.checked }))
                }
                className="h-4 w-4 accent-even-blue-600"
              />
              <span className="block text-body text-even-navy-800 truncate">{email}</span>
            </label>
            <button
              type="button"
              onClick={() => removeExtra(email)}
              className="text-caption text-even-ink-400 hover:text-danger-700 px-1"
              aria-label={`Remove ${email}`}
            >
              Remove
            </button>
          </li>
        ))}
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
                addExtra();
              }
            }}
            autoComplete="email"
            className="flex-1 rounded-md border border-even-ink-200 px-3 py-2 text-body text-even-ink-800 focus:outline-none focus:ring-2 focus:ring-even-blue-300"
          />
          <Button variant="secondary" onClick={addExtra}>
            Add
          </Button>
        </div>
        {inputError ? (
          <p className="mt-1 text-caption text-danger-700">{inputError}</p>
        ) : null}
        {!savedLoaded ? (
          <p className="mt-2 text-caption text-even-ink-400">Loading your contacts…</p>
        ) : saved.length === 0 ? (
          <p className="mt-2 text-caption text-even-ink-400">
            Tip: save frequent recipients via{" "}
            <a href={`/${slug}/recipients`} className="text-even-blue-600 hover:underline">
              Manage contacts
            </a>
            {" "}to one-tap them here.
          </p>
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
