import { STOP_COOLDOWN_MS } from "./constants.js";

export interface UnreadSummary {
  count: number;
  ids: string[];
  from: string[];
}

/** Counts, ids, and handles only. Never subjects or bodies. */
export function formatRegistered(handle: string, address: string, unread: UnreadSummary): string {
  if (unread.ids.length === 0) return `ubus: registered as ${handle} (${address}). 0 unread.`;
  return `ubus: registered as ${handle} (${address}). ${unread.count} unread from ${unique(unread.from)} (ids ${unread.ids.join(", ")}). Use ubus_inbox to read.`;
}

export function formatPrompt(unread: UnreadSummary): string | null {
  if (unread.ids.length === 0) return null;
  return `ubus: ${unread.count} unread from ${unique(unread.from)} (ids ${unread.ids.join(", ")}). Use ubus_inbox.`;
}

export function formatWatch(unread: UnreadSummary): string {
  return `ubus: ${unread.count} new messages (ids ${unread.ids.join(", ")}). Use ubus_inbox.`;
}

export function decideStop(input: {
  unread: UnreadSummary;
  lastBlockAt: string | null;
  now: number;
  cooldownMs?: number;
}): { block: boolean; reason?: string } {
  if (input.unread.ids.length === 0) return { block: false };
  const cooldown = input.cooldownMs ?? STOP_COOLDOWN_MS;
  if (input.lastBlockAt) {
    const last = Date.parse(input.lastBlockAt);
    if (Number.isFinite(last) && input.now - last < cooldown) return { block: false };
  }
  const ids = input.unread.ids.join(", ");
  return {
    block: true,
    reason: `ubus: ${input.unread.count} unread messages addressed to you (ids ${ids}). Read with ubus_inbox, then reply or ack before finishing.`,
  };
}

function unique(items: string[]): string {
  return [...new Set(items.filter(Boolean))].join(", ");
}
