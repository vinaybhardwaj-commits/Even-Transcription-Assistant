# ORDER — scribe3: start tonight's run now (Fable, 21 Sep 20:45). V: "the clinic day is over."
Scope: the local driver only (~/overnight-translate and hours.ts on vinay/overnight-translate). Production and the Vercel app are untouched; this is not a deploy.
1. In hours.ts, add a deliberate override: env `ETA_OVERNIGHT_OPEN_EARLY=1` lets submits start from 19:00 IST instead of 21:30. Nothing else changes: the 07:10 stop is unchanged, and the override does nothing between 07:10 and 19:00. Unset means exactly today's behaviour.
2. Tests: unset → 20:45 blocked and 21:31 open; set → 20:45 open and 18:59 blocked; set → 07:11 blocked (stop still wins). Run the hours tests plus the overnight suite. Commit on vinay/overnight-translate (a new commit; don't amend).
3. Rebuild ~/overnight-translate/overnight-translate.mjs from release HEAD plus this commit. Add the env var to the launchd plist, then restart the job with the same --limit 5 canary. Leave the watcher running.
4. Report ≤5 lines: commit hash, test counts, the time of the first submit. I'll check the diff myself. Remove the env var from the plist when tonight's run ends (step 6 of the deploy order); it's for tonight.
If any step fails, stop and fall back to 21:30. Don't improvise.
