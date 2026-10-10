/**
 * lib/jev/worker/nudge.ts — the optional event nudge (PRD §3.2, §9.5): a trigger point (e.g. "Nemotron turns landed") asks the sweeper to look at
 * ONE use now instead of at the next cron tick. FIRE-AND-FORGET: it never throws and never awaits anything its caller depends on, so a queue or
 * database failure cannot fail capture, upload, STT or note generation. Only the allowlisted code is logged. The sweeper still guarantees completeness.
 * No capture or STT module imports lib/jev (a test pins it).
 */
import { modeGate, type RealUse } from "./flags";
import { sweepUse } from "./sweeper";
import { usesOf } from "./uses";

export async function nudgeJev(use: RealUse): Promise<void> {
  try {
    if (!modeGate(use, "shadow").ok) return;
    for (const def of usesOf(use)) await sweepUse(def, "nudge:jev");
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    console.warn("[jev] nudge failed", JSON.stringify({ use, code: typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? `db_error:${code}` : "nudge_failed" }));
  }
}
