/**
 * lib/preop/gate.ts — the one place the pre-op surface's gate is defined.
 *
 * It lives in lib/ rather than beside the routes because a Next.js route module may
 * export ONLY route handlers and route config: exporting a helper from
 * app/api/.../route.ts type-checks under `tsc --noEmit` and then fails `next build` with
 * "not a valid Route export field". Caught by the production build on 26 Aug, which is
 * exactly the class of defect the SREWS `surgeryDateKey` lesson is about — the app graph
 * is checked by a different tool than the library graph.
 *
 * Every consumer re-checks independently: the board page, the case page, and all three
 * read/write routes call this rather than trusting whoever called them.
 */
import { isCareUnlocked } from '../care-cookie';
import { isAdminUnlocked } from '../admin-cookie';
import { parseExtractMode, scoreModeReachable, type PreopExtractMode } from '../preop-suggest-core';

/** Both flags, ANDed. PREOP_SURFACE_ENABLED ships OFF; V flips it after deploy verification. */
export function preopSurfaceEnabled(): boolean {
  return process.env.CCB_ENABLED === '1' && process.env.PREOP_SURFACE_ENABLED === '1';
}

/** The care-manager cookie, or an admin session. Fail-closed on any error. */
export async function preopAuthed(): Promise<boolean> {
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

/**
 * Who is recording a decision. The care surface is cookie-gated rather than per-user
 * authenticated, so the honest label is the ROLE plus the gate that let them in — never a
 * fabricated name. When an admin session is what unlocked the page, say so.
 * ⚠️ FLAGGED FOR V: real per-user identity on /care would make the B8d precision measurement
 * attributable, and this module cannot invent it.
 */
export async function preopDecider(): Promise<string> {
  try { if (await isCareUnlocked()) return 'care-manager'; } catch { /* fall through */ }
  try { if (await isAdminUnlocked()) return 'admin'; } catch { /* fall through */ }
  return 'unknown';
}

/**
 * Flag state, reported on every payload — never a matter of belief on a clinical screen.
 *
 * B8 replaced the extraction boolean with a MODE, and the payload carries the mode itself
 * rather than an on/off collapse of it: a reader of the case page needs to know the
 * difference between "the model never ran" and "the model ran and everything it found is
 * waiting for someone to confirm it".
 */
export function preopFlagState(): {
  extraction: PreopExtractMode;
  narrative: 'on' | 'off';
  scoreModeReachable: boolean;
} {
  return {
    extraction: parseExtractMode(process.env.PREOP_EXTRACT_MODE),
    narrative: process.env.PREOP_NARRATIVE_ENABLED === '1' ? 'on' : 'off',
    // B8d: `score` mode is configured but unreachable until V ratifies a class. Reported so
    // that a mode of 'score' on a screen can never be mistaken for anything auto-accepting.
    scoreModeReachable: scoreModeReachable(),
  };
}
