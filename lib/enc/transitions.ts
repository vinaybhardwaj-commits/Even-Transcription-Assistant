/**
 * lib/enc/transitions.ts — the only allowed steward_item state changes. Pure.
 *   open -> approved | rejected   (admin session, PATCH)
 *   approved -> done | failed     (steward result, bearer)
 * Anything else is refused. rejected, done and failed are final.
 */
import type { ItemState } from "@/lib/enc/schemas";

const ALLOWED: Record<ItemState, readonly ItemState[]> = {
  open: ["approved", "rejected"],
  approved: ["done", "failed"],
  rejected: [],
  done: [],
  failed: [],
};
export const canTransition = (from: ItemState, to: ItemState): boolean => ALLOWED[from].includes(to);
