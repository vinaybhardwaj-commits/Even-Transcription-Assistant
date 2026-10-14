# LOG — LABVIEW (lab viewer + rating pages)

Build and event log, newest first. Owner panes: lab-viewer (builder), eta-refuter-2 (checker).

## 26 Sep ~16:45 IST — 427L label200 fix LIVE
Session: lab-viewer (builder) + eta-refuter-2 (checker) + Fable (merge/deploy).
V's rating page repaired and deployed (v6713bbe8). R5 recompute = 16 rows sha 93fdea08; lang-map frozen-push readback matches. 451 values applied: ALLOWED_EMAILS 6 (e99e991d), RATERS 3 (f9db54a), old 41dff5bb confirmed, stdin-only puts.
Refs: #3645, #3660, #3667, #3669-71; FABLE 450, r451.

## 25 Sep — viewer rebuilt after "not fit for purpose"
Session: lab-viewer.
V ruled the early viewer unfit (raw JSON, not transcripts) r328. Redesigned viewer live at lab.llmvinayminihome.uk behind Cloudflare Access; Consult View (337a) with English under native lines; rating sets hosted (r359); Access allowlist extended to 5 Even emails (r353).
Refs: r328, r337a, r353, r359.

## 24 Sep 23:00 IST — vault Part A
Session: lab-viewer + join-shard + tunnel-ops.
R2 vault with write-once + SHA256 (r184/195); 3-copy check (box/R2/Mini).
Refs: r184, r195.

## Open
Speaker A/B/C chips in consult view; `/roadmap` page rendering docs/ROADMAP.md; calib30 chunkPlan fix (queued, own check).
