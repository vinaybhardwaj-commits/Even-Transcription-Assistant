# Fable rulings — 24 Sep 10:30 IST (45–54)

45. **Nemotron fine-tune — ruling 44 is superseded by eta-refuter-2's T1 hold.** Run 1 (8c00580) is TAINTED: do not use it for any decision. It also made speaker-count error worse (0.4 → 1.4), so DER alone is not the target.
    Clean run 2 (owner diar-lab, gcp-l4):
    - Exclude all 15 test room-days from train/val, and apply T2 (re-fetch the 16 WAVs).
    - eta-refuter-2 checks the split BEFORE training starts. This is a split check only, ≤15 min.
    - Primary metric: speaker-count error vs V on held-out (target ≤0.2). DER is secondary.
    - Score the count at every checkpoint and stop on count, not loss.
    - Endpoint :8002 stays tailnet-only and is never public. E1 (/health probes embed) is accepted.
46. **VAD trim:** DIARIZE_VAD_TRIM stays OFF (lab-mover #130 accepted). No offline port for now. Closed.
47. **train-24sep-eve @ be15c07:** PASS noted (#127). At 12:30 scribe ships ONE production deploy:
    - be15c07 pushed to vinay/s1-auto-drain;
    - bulk env (lab-mover BULK-ENV.md) + night-feeder token.
    - Smoke-test after. On any failure, roll back to dpl_EnpLbxzcSn4L8kyEZbjRrAaHrh2R and report.
48. **Surgery v2 pilot is LIVE:**
    - Fable published it at the same artifact link, seeded P01–P05 (bucket stripped). The 36 clips are served as page files at their fleet paths.
    - The v1 consults are removed from the db; a backup is kept.
    - surg-page:
      - commit v2-page.html + mocks to tools/surgery-review/ (mocks are invented, OK);
      - remove the 'quality poor' note (bias), commit, and tell Fable the sha. Fable republishes.
    - Ratings schema = the page's: `ratings/<rater id> {c:{<consult>:{a:{...}}}}`.
    - Audio privacy: org-internal page, Even physicians only (V's standing rule).
49. **surg-deid:**
    - Own doctor's bare surname: KEEP.
    - EPI roster: 265 names (Governance DB, names only) at box `~/eta-data/deid/epi-roster-names.txt`. Whitelist them. It is NOT for git.
    - Non-Latin orig: option 1 (`--drop-nonlatin-orig`) is the pilot rule. Transliteration is a production follow-up.
    - Commit deid.py + deid_eval.py (code only); then eta-refuter-2 refutes.
50. **R2 read-only token (lx #142, join-shard c3 twin):** owner lab-mover.
    - Use `~/.claude/secrets/cloudflare_api_token` via the Cloudflare API to mint a READ-ONLY R2 S3 credential scoped to the audio bucket.
    - Save it to box `~/.claude/secrets/r2_read_access_key_id` / `r2_read_secret` (0600) and copy it to c3.
    - Never print it or put it on argv. If the token can't mint tokens, report it; Fable asks V.
51. **join-shard:** gate green (9c2cd02). eta-refuter refutes now. Deploy after 20:30 on Fable's go only.
52. **fleet D1b/ruling 42 (9ec4401):** fleet pushes the branch; eta-refuter-2 refutes; Fable merges.
53. **diarize-c3 timeout (398.7 s vs 300 s):** c3 takes BULK diarize only, with a 480 s timeout. Live stays on box/Mini. The conductor maps this onto the a/b/c options.
54. **Whisper temperature decision:** stays at 12:00 (split-speaker arms A–D).

## Addendum 10:30 — join-shard #155 (ruling 55)
55. join-shard:
    - (1) YES: mint a NEW R2 S3 key pair for the c3 join twin (read tape, write clips/ only) with the Cloudflare token.
      - Also mint the READ-ONLY pair from ruling 50 in the same pass. lab-mover stands down on 50.
      - Store both 0600 in ~/.claude/secrets on box and c3. Never print them.
    - (2) YES: add the c3 twin to AUDIO_JOIN_URLS. It ships only with tonight's post-20:30 deploy after Refuter PASS.
    - (3) PUSH vinay/join-shard now; eta-refuter refutes (ruling 51). max_instances 33 is approved.
    - The invalid Vercel CLI token on the box: env changes go through the Mini's Vercel CLI (scribe), not the box.
