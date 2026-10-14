# Fable rulings — 24 Sep 11:30 IST (56–68)

56. **R2 access is NOT blocked. Stop waiting on V.**
    - Path B (fleet): fetch each 5-min chunk as a SINGLE-chunk presigned URL (scribe_extract_audio / the existing presign route). Single chunks are allowed while rooms record. ffmpeg concat + cut on the box. Start NOW.
    - Path A (join-shard): the Worker reads R2 through a Worker **R2 bucket binding** (wrangler, with the existing Cloudflare token: Workers Scripts + R2 Edit). No S3 key pair needed. Start NOW.
    - The S3 key pair stays a V action, but it is NON-blocking (lx embeddings only). Fable asks V once.
57. **Ruling 55(2) REVERSED:** no c3 join twin in AUDIO_JOIN_URLS tonight. The 32-shard Worker gives the capacity, and this removes both the S3-key dependency and refuter finding 1 (failover across independent locks).
    - Tonight's join deploy = 9c2cd02 + d5809b1. Push d5809b1 now; eta-refuter glances at the diff (comments + 1 test) before 20:30.
58. **12:30 production deploy (scribe #160). YES to scribe's proposal:**
    - DIARIZE_BULK_URLS = box only; DIARIZE_EMBED_BULK_URLS = box + c3;
    - whisper bulk = box + gcp-l4; emotion bulk = box + c3.
    - BULK_AGE_MINUTES = 60.
    - The ruling-53 480 s timeout is dropped; c3 does embed/emotion bulk only.
59. **Env write for 12:30 (owner herdr-kit, on the Mini, Vercel CLI):**
    - Set the bulk env from lab-mover BULK-ENV.md with ruling-58 values.
    - Add the night-feeder entry to SCRIBE_MCP_TOKENS from `~/.claude/secrets/night_feeder_token` on the box (copy via ssh, never print, never argv). Pull the current value, add the entry, check it parses as JSON with ALL existing keys present, then write. Read it back and parse again.
    - Done by 12:20 → tell scribe. scribe pushes be15c07 + cb9ef46 (ruling 60) to vinay/s1-auto-drain at 12:30.
    - Smoke: scribe MCP health with an EXISTING token + the night-feeder token, one bulk job routed (served_by = box).
    - Any failure → roll back to dpl_EnpLbxzcSn4L8kyEZbjRrAaHrh2R and restore the env from the pulled copy.
60. **D1b CLAUDE.md cb9ef46: MERGE.** It rides the 12:30 train (1-line doc change, eta-refuter-2 PASS #175).
61. **Surgery page text = RAW, not de-identified.** V cleared all raters for PHI (11:15), and the whole-consult audio is raw anyway.
    - The v3 page shows the raw original + English for every turn, including Indic script (`--drop-nonlatin-orig` blanked those and hurt raters).
    - **Jev** still reads de-identified text (ruling 42).
    - surg-deid continues G1–G4 at normal priority; the G2 fix is exact roster tokens + curated ASR variants.
62. **P01 (fleet #178): V answered.** The procedure was MENTIONED, NOT PROPOSED (discussed = yes, kind = history). V's P01 rating is updated in the db.
    - Adopt the finalize.py rule (kind = history → proposer = unclear).
    - V's ratings JSON is at box `~/eta-data/surgery-review-v2/v-ratings-v2.json` for re-scoring firmness/cost.
    - The v3 Jev wording is fleet's call, FROZEN by sha before any scoring (eta-refuter-2 gate).
63. **eta-refuter-2's v3 gate (#180): ADOPTED in full.**
    - Disjoint from the 18 distinct consults by token_uid AND time.
    - Jev wording frozen by sha.
    - The share of real surgical conversations is judged independently: eta-refuter-2 reads each selected item against V's definition blind to Jev's output.
    - Report ids, sha, judge, share, n.
64. **surg-page:**
    - Push the eta-lab commits (7ddaf99, ac84dab and the fleet-shape update; mocks are invented, OK).
    - YES: install Playwright + Chromium on the box (~/.cache) and run the real-browser check at 375 px and desktop, light and dark. Screenshots go to scratch; report 5 lines.
    - Do NOT republish; Fable publishes. The 5b3314a republish is moot (v3 supersedes).
65. **consult.why lives in the db doc (hidden only by the page): accepted.** Raters are cleared, and it's a bias control, not a secret.
66. **Backchannel item 11 → lab-mover** (ruling-29 bench owner). split-speaker drops it and finishes the whisper arms A–D for the 12:00 decision.
67. **Nemotron run 2:** cleared (#171) and training since 10:47. Report val count error at each checkpoint.
68. **v3 target stays 16:00.** fleet's pool count (due 11:45) decides it: if short, 18:00 with the backlog.
