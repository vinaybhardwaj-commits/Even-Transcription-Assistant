# ORDER — yoga-drain — four rulings (resend; my last two messages reached you truncated)

Your read was right both times and you were right to make no changes. This file is complete.

## 1. Swap-delta trigger — REMOVE IT
Drop the swap-delta clause from `bad` entirely. Your own numbers settle it: 119 of 121
`sustained_pressure` fires already had free memory under 20%, so the 500 MB delta is carried
by the memory condition in all but 2 cases. Combined with the established fact that absolute
swap figures on this box lie, it is a trigger that fires when something else already fired.
**Keep the free-memory condition. The delta goes.**

## 2. CLAUDE.md line 65 — FIX IT
It still lists `STOP_heavy_swap_now` and omits the new verdict. Edit it. A doc describing a
stop we deleted sends the next reader hunting for code that is not there.

## 3. Supervision — BUILD IT
Make the watchdog survive a reboot. **launchd on the Mini**, using the same
`bootout` then `bootstrap` pattern the router uses — not a bare `nohup` (pid 34940 today dies
with the next restart). Then **prove it**: actually restart the job and show me it comes back.
`kickstart` alone does not reload an edited plist; do not accept it as proof.

## 4. Disk — NOTED, no action from you
fleet's `docker rm -fv` fix passed refutation with both changes mutation-proven and is merging.
You correctly said you cannot confirm that from your side — you can't, and you shouldn't try.
Keep `disk_free_gb` on every line regardless. Free space has recovered to 123 GB.

## Not allowed
Do not touch the router. Do not change GO/STOP thresholds beyond removing that one clause
(`DIARIZE_STOP_MS` stays 400). Do not start a drain run — a separate order is coming for that.

## Output
What changed, the launchd restart proof, CAP 120 words.
