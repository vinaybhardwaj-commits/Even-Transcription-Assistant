"use client";

import { useState } from "react";
import { contextLine, type CardResponse, type DoctorCard } from "@/lib/doctor-card";
import {
  askText,
  friendlyError,
  REACTION_LABELS,
  responseInWords,
} from "@/lib/finding-labels";

/**
 * The one finding card, used by both Findings lists (live and document). It renders a DoctorCard
 * and nothing else: the server has already removed everything a physician must not see, and this
 * component has no field to print a reference, a status code or an author even by mistake.
 *
 * Layout: title, context line (note type · date · patient · IP/UHID), the finding, "Why it
 * matters", a collapsed "Evidence" section (hidden when there is none), the action line with its
 * controls (or the doctor's past response in words), and "View note".
 *
 * A private reaction and a response are different gestures and stay in separate rows. Errors are
 * always plain sentences (`message` from the route, else mapped here from the code).
 */

const chipCls = (on: boolean) =>
  `px-3 py-2 rounded-lg text-[12.5px] font-medium border disabled:opacity-50 ${
    on ? "bg-brand text-white border-brand" : "bg-white border-stone-200 text-stone-600"
  }`;
const rowCls = "mt-3 pt-3 border-t border-stone-100";
const labelCls = "text-[12px] font-semibold text-stone-500";

const REACTION_ORDER = ["already_knew", "surprised", "dismiss"] as const;

type Verb = "agree" | "disagree" | "needs_clarification";

interface ActionResult {
  ok?: boolean;
  error?: string;
  message?: string;
  /** The new state of the finding (status + recorded response). Merged into the existing card. */
  state?: { status: string | null; response: CardResponse | null } | null;
}

function sentence(j: ActionResult | null): string {
  return j?.message || friendlyError(j?.error);
}

function ReactionRow({ card, onChanged }: { card: DoctorCard; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const selected = card.reaction ?? picked;
  const locked = Boolean(card.reaction) || busy || picked !== null;

  async function react(v: string) {
    if (locked) return;
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch("/api/portal/findings/react", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signal_id: card.id, reaction: v }),
      });
      const j = (await r.json()) as ActionResult;
      setBusy(false);
      if (j.ok) setPicked(v);
      else if (j.error === "already_recorded") onChanged();
      else if (j.error === "unmapped") setHidden(true);
      else setErr(sentence(j));
    } catch {
      setBusy(false);
      setErr(friendlyError("unavailable"));
    }
  }

  if (hidden) return null;
  return (
    <div className={rowCls}>
      <div className={labelCls}>Your reaction (only you can see this)</div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {REACTION_ORDER.map((v) => (
          <button
            key={v}
            type="button"
            disabled={locked}
            onClick={() => react(v)}
            className={chipCls(selected === v)}
          >
            {REACTION_LABELS[v]}
          </button>
        ))}
      </div>
      {err && <div className="mt-1.5 text-[12.5px] text-rose-600">{err}</div>}
    </div>
  );
}

function ResponseControls({
  card,
  onChanged,
  onResponded,
}: {
  card: DoctorCard;
  onChanged: () => void;
  onResponded: (id: string, response: CardResponse) => void;
}) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send(verb: Verb) {
    if (busy) return;
    setErr(null);
    setBusy(true);
    const live = card.source === "live";
    try {
      const r = await fetch(
        live ? "/api/portal/findings/respond" : "/api/portal/document-audits/respond",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            live
              ? { signal_id: card.id, verb, comment }
              : { finding_id: card.id, verb, comment },
          ),
        },
      );
      const j = (await r.json()) as ActionResult;
      if (j.ok) {
        // Stay busy: this block is about to be replaced by the recorded response either way.
        if (j.state?.response) onResponded(card.id, j.state.response);
        else onChanged();
        return;
      }
      setBusy(false);
      setErr(sentence(j));
      if (j.error === "already_responded" || j.error === "closed" || j.error === "on_live_list") onChanged();
    } catch {
      setBusy(false);
      setErr(friendlyError("unavailable"));
    }
  }

  const empty = comment.trim().length === 0;
  const agreeLabel = card.ask === "explain" ? "Confirm" : "Acknowledge";
  return (
    <div className="mt-2">
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        disabled={busy}
        rows={3}
        aria-label="Your comment"
        placeholder={
          card.ask === "explain"
            ? "Add a short explanation (needed if you disagree or want clarification)"
            : "Add a comment (needed if you disagree or want clarification)"
        }
        className="w-full rounded-lg border border-stone-200 px-3 py-2.5 text-[16px] bg-white"
      />
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <button type="button" disabled={busy} onClick={() => send("agree")} className={chipCls(true)}>
          {agreeLabel}
        </button>
        <button
          type="button"
          disabled={busy || empty}
          onClick={() => send("disagree")}
          className={chipCls(false)}
        >
          I disagree
        </button>
        <button
          type="button"
          disabled={busy || empty}
          onClick={() => send("needs_clarification")}
          className={chipCls(false)}
        >
          I need clarification
        </button>
      </div>
      {err && <div className="mt-1.5 text-[12.5px] text-rose-600">{err}</div>}
    </div>
  );
}

export function FindingCard({
  card,
  reactions = false,
  respond = false,
  onChanged,
  onResponded,
}: {
  card: DoctorCard;
  reactions?: boolean;
  respond?: boolean;
  onChanged: () => void;
  onResponded: (id: string, response: CardResponse) => void;
}) {
  const ctx = contextLine(card);
  const hasEvidence = Boolean(card.excerpt) || card.citations.length > 0;
  const ask = askText(card.ask);

  return (
    <article className="border border-stone-200 rounded-lg px-4 py-3.5">
      <h3 className="text-sm font-semibold break-words">{card.title}</h3>
      {ctx && <div className="mt-0.5 text-[12px] text-stone-500 break-words">{ctx}</div>}

      {card.subject && (
        <p className="mt-2.5 text-sm font-medium break-words">{card.subject}</p>
      )}
      {card.seen_in && <div className="mt-1 text-[12px] text-stone-500">{card.seen_in}</div>}

      {card.why_it_matters && (
        <div className="mt-2.5">
          <div className={labelCls}>Why it matters</div>
          <p className="mt-0.5 text-[13px] text-stone-600 leading-snug break-words">
            {card.why_it_matters}
          </p>
        </div>
      )}

      {hasEvidence && (
        <details className="mt-2.5 group">
          <summary className="cursor-pointer text-[12.5px] font-medium text-brand select-none">
            Basis
          </summary>
          <div className="mt-1.5 space-y-2">
            {card.excerpt && (
              <blockquote className="border-l-2 border-stone-200 pl-3 text-[13px] text-stone-600 leading-snug whitespace-pre-line break-words">
                {card.excerpt}
              </blockquote>
            )}
            {card.citations.length > 0 && (
              <ul className="space-y-1">
                {card.citations.map((c, i) => (
                  <li key={`${i}-${c.title}`} className="text-[12px] break-words">
                    {/* No url, no link: a source that looks pressable but goes nowhere erodes trust. */}
                    {c.url ? (
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-brand font-medium"
                      >
                        {c.title}
                      </a>
                    ) : (
                      <span className="text-stone-500">{c.title}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </details>
      )}

      {card.response ? (
        <div className={rowCls}>
          <p className="text-[12.5px] text-stone-600 bg-stone-50 border border-stone-100 rounded-md px-3 py-2 leading-snug break-words">
            {responseInWords(card.response, card.ask)}
          </p>
        </div>
      ) : ask ? (
        <div className={rowCls}>
          <div className="text-[13px] font-semibold text-stone-800">{ask}</div>
          {respond && card.can_respond ? (
            <ResponseControls card={card} onChanged={onChanged} onResponded={onResponded} />
          ) : (
            !respond && (
              <p className="mt-1 text-[12px] text-stone-500">
                Responding here is not available yet. Please reply to the quality team directly.
              </p>
            )
          )}
        </div>
      ) : null}

      {reactions && card.can_react && <ReactionRow card={card} onChanged={onChanged} />}

      {card.view_note_href && (
        <a
          href={card.view_note_href}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex rounded-lg border border-brand bg-brand/10 px-3 py-1.5 text-[12.5px] font-semibold text-brand hover:bg-brand hover:text-white"
        >
          View note
        </a>
      )}
    </article>
  );
}
