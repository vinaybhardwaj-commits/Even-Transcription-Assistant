# RATE20-PREREG — pre-registration for the rate20 (r337f) labels (Fable r413c via eta-refuter #2788)

Written by lab-viewer (owner of the page's label schema; surg-page owns the seed) BEFORE any rate20 label
arrives, so the report can never be accused of post-hoc rules. Committed branch-first, eta-refuter PASS,
then main. Counts and hashes only; no patient text anywhere in this file or in any scoring output.

## 1. The label set (exactly what the page can store)

Per excerpt, four single-choice radio questions, all mandatory before an excerpt counts as rated:

| key | question | allowed values |
|---|---|---|
| readable | Readable? | yes / partly / no |
| useful | Useful? | yes / little / no |
| wrong_lang | Wrong language? | no / some / most |
| garbled | Garbled? | none / some / much |

Plus one conditional question, shown and mandatory ONLY for excerpts where at least one line carries
English (`en_ok`: "English right?", values yes / partly / no). No "unsure" option exists anywhere (the
middle value is the closest); an optional free-text `note` per excerpt exists but is NEVER scored,
exported to reports, or put on the bus (see 6). Anything else in a stored answer (unknown key, unknown
value, missing mandatory question) = the row is REFUSED by the scorer and counted as unrated, loudly.

## 2. What is reported

Per question per allowed value: k/n with a two-sided exact Clopper-Pearson 95% interval (alpha 0.05),
computed on the primary rater's completed set. At n=20 no percentage stands alone: a bare share without
its interval is a rule breach. n = excerpts rated by that rater (max 20; state n, never assume 20).
The `en_ok` question reports its own n (English-bearing excerpts only).

## 3. Thresholds

Descriptive only, no pass/fail. r337f states no success threshold and none is invented here; any future
pass/fail needs its own ruling stated before labels land.

## 4. Raters

vinay (V) is PRIMARY (as with ba106); sandhya is the second. Agreement on the excerpts BOTH rated:
raw percent agreement per question + Cohen's kappa (unweighted), each with n stated. Kappa at n<=20 is
notoriously unstable: report it, do not interpret it without eta-refuter.

## 5. seed2 (English-on-some-lines) variant

Seed = the pinned seed2 loaded 25 Sep (bucket rate-seed sha prefix 3e83659314aa1779). English-bearing
excerpts are NOT scored separately on the four core questions (same pool, same rule as 2); the `en_ok`
question IS its own stratum (own n, own counts + intervals). A secondary descriptive split of the core
four by has-English / no-English may be shown with n per side; it is descriptive only, no test across
strata (the intervals already carry the uncertainty).

## 6. Export and key binding (the ba106 lesson)

Export: `python3 kit/lab-viewer/tools/rate_seed.py export --set rate20 --out ~/eta-data/readability-rate/labels-seed2 --rater vinay=... --rater sandhya=...`
per rater writes `<out>/<name>.json` (0600) = `{"<excerpt_id>": {answers object}}`, exactly the page's
schema-1 `t` map. The scorer MUST refuse, before computing anything:
- a document whose rate-seed/rate20.json sha256 does not start 3e83659314aa1779 (seed drift = wrong ids);
- any excerpt_id not in the pinned seed (0 tolerated; names the count, not the text);
- any answer failing section 1's key/value/mandatory check (refused row, reported);
- any `note` or `ts` field leaking into the printed report (strip at load).
Bucket keys stay `rate/rate20/<sha256(email)[:16]>.json` in eta-lab-ratings; the rater->hash map lives
only in the export invocation, never in git or on the bus.
