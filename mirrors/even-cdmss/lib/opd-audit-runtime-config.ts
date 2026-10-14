/**
 * lib/opd-audit-runtime-config.ts — runtime bounds shared by the OPD audit path and its reconciler.
 * On-path kickoff D13. PRD v2.1 §4.5 step 6.
 *
 * PURE CONSTANTS. No env reads, deliberately: a preregistered value that can be changed by setting
 * a variable is not preregistered.
 */

/**
 * The worker route's `maxDuration`.
 *
 * ⚠️ THIS CONSTANT IS NEW, AND SO IS THE FACT THAT IT EXISTS AT ALL. Earlier kickoff versions named
 * `WORKER_MAX_DURATION_SECONDS` as an existing fact. It was not one — what existed was a bare route
 * literal, `export const maxDuration = 800` in app/api/opd-audit/worker/route.ts. A source-text pin
 * holds the two together, because a reconciler grace derived from a number that has silently moved
 * is worse than no reconciler.
 *
 * ⚠️ AND 800 IS THE MAXIMUM AMONG THE INSTRUMENTED ROUTES, NOT THE VALUE EACH CARRIES. The worker
 * and the appropriateness route are 800; the run route, mini-backfill, lab-batch, the low-value-care
 * A/A route and both MCP routes are 300. See the note on the grace below.
 */
export const WORKER_MAX_DURATION_SECONDS = 800;

/**
 * THE PREREGISTERED GRACE (D13, §4.5 step 6).
 *
 * ⚠️ RECORDED IN THE BUILD REPORT BEFORE ANY CANARY OPENS, AND IT CANNOT BE TUNED AFTERWARDS TO
 * MAKE A GATE PASS. Changing it restarts the window. That is the whole reason it is a committed
 * constant in a shared module rather than a number chosen by whoever runs the reconciler.
 */
export const RECONCILER_GRACE_SECONDS = 1800;

/**
 * How stale a non-terminal row must be before the reconciler may touch it.
 *
 * ⚠️ CONSERVATIVE FOR MOST ROWS, DELIBERATELY. 800 is the highest `maxDuration` among the
 * instrumented routes, so a row from one of the 300-second routes waits 2,600 seconds before
 * reconciliation when its own route could not possibly have run for more than 300. ONE grace for
 * every row is the choice, because a per-route grace is a tuning surface and this value must not
 * be one. The trade is stated rather than hidden: reconciliation of short-route rows is later than
 * it strictly needs to be, and in exchange nobody can shorten a grace to make a window close.
 */
export const RECONCILER_STALE_AFTER_SECONDS = WORKER_MAX_DURATION_SECONDS + RECONCILER_GRACE_SECONDS;
