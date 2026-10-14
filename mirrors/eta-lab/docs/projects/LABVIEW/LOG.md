# LOG — LABVIEW (lab viewer + rating pages)

Build and event log, newest first. Owner panes: lab-viewer (builder), eta-refuter-2 (checker).

## 26 Sep ~21:0x IST — rating hub /rate LIVE
Session: lab-viewer, eta-refuter-2, Fable (deploys).
Branch 5efcbbc5 PASS (#3910), cherry-picked to main 974b347a (#3911), raters only, counts and times only. Speaker-count, Doctor Voice Check and surgery v4 are not viewer sets so the hub does not list them (#3909). CAP-1 items beside consults: cap posted the scored_items location (#3925); it sits on c3, not the box.
Refs: #3909, #3910, #3911, #3925.

## 26 Sep ~18:0x-19:5x IST — /roadmap and speaker chips LIVE
Session: lab-viewer, eta-refuter-2, Fable (deploys).
/roadmap branch e4000863 PASS (#3834/#3844), merged 79fd7af9, deployed as version 0ea4917a; Access redirect verified (#3860). Speaker chips 7e3efd13 FAIL (#3865, two blocking), fixed 5213ea3e PASS (#3872), main 207821ba, deployed by Fable as e07cff51. W27.4 next: CAP-1 items beside consults, rating hub.
Refs: #3856, #3860, #3872, #3873.

## 26 Sep ~18:0x IST — /roadmap page BUILT + PASS (ede99072)
Session: lab-viewer (builder) + eta-refuter-2 (checker).
Branch lab-viewer/roadmap-page @ ede99072 (7 files, +299/-2): /roadmap renders docs/ROADMAP.md + docs/DECISIONS.md from main via a deploy-time snapshot (tools/embed_roadmap.py → worker/roadmap_docs.js single JSON export). refuter-2 PASS (ran everything + own injection battery): route strictly behind verifyAccess (RS256/JWKS/ALLOWED_EMAILS, fails closed), escape-first renderer (fixed tag set, no <a> emitted), per-response nonce CSP, byte-exact snapshot, word-scan exemption justified (data-only JSON). 32/32 viewer, 3/3 embed, Chromium render clean. No deploy — holding for Fable's word. No PHI (counts/ids/shas only).
Refs: #3776, #3779, #3781.

## 26 Sep ~15:5x IST — 451 thread CLOSED via Zaki login
Session: Fable (r453.B.3) + eta-refuter-2 + lab-viewer + conductor.
The #3706-3713 email-hash thread CLOSED: deployed, verified by Zaki's successful login. The two list shas (AE6/R3) stay UNVERIFIED by design — the entry string is off-bus per Fable's 451 rule; close = out-of-bus ask or Zaki's first login (which landed).
Refs: #3713, #3714, #3715, #3716.

## 26 Sep ~16:45 IST — 427L label200 fix LIVE
Session: lab-viewer (builder) + eta-refuter-2 (checker) + Fable (merge/deploy).
V's rating page repaired and deployed (v6713bbe8). R5 recompute = 16 rows sha 93fdea08; lang-map frozen-push readback matches. 451 values applied: ALLOWED_EMAILS 6 (e99e991d), RATERS 3 (f9db54a), old 41dff5bb confirmed, stdin-only puts.
Refs: #3645, #3660, #3667, #3669-71; FABLE 450, r451.

## 26 Sep ~18:05 IST — 451 spot-check PASS
Session: eta-refuter-2 (checker).
Live worker/ code byte-identical to the PASSed d5e82fe bundle; /rate/label200 + / still 302 → Access login (intact). The ALLOWED_EMAILS(6)/RATERS(3) shas are V-verifiable only by design (stdin-only hygiene). No findings; 451 stands.
Refs: #3703.

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
