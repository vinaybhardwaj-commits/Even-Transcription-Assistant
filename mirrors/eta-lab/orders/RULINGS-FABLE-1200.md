# Fable rulings — 24 Sep 12:00 IST (69–82)

69. **12:30 push: GO.**
    - scribe pushes train 5970852 (be15c07 + cb9ef46) to vinay/s1-auto-drain at 12:30.
    - The R58 1-second lockout flake is accepted (26/26 pass alone x3; be15c07 gated 4546/4546).
    - Rollback triggers as ruled. The night-feeder 401 is NOT a trigger.
70. **Night-feeder token: option A tonight** (the feeder uses an existing token), then C (additive code, next train). B is closed.
71. **herdr-kit using V's logged-in Vercel CLI on the Air over ssh: accepted.** It is V's machine and authority, and the pulled env files were deleted. That is the sanctioned route for Vercel env writes until the Mini has its own CLI.
72. **Whisper temperature (split-speaker FALLBACK-ARMS.md 5533af7):**
    - Production keeps arm A (fallback on).
    - Arm B (temperature_inc=0) is the EVALUATION and PARITY config for every lab/twin comparison.
    - Fix the wrong "no fallback" comment in lib/whisper.ts. It rides tonight's train.
    - split-speaker then switches to Sonnet (model table).
73. **De-id shas:** CLAUDE.md line → cite a1ffdb9 (G1–G4 at 7306500).
    - fleet updates vinay/claude-md-d1b-ruling42; eta-refuter-2 rechecks; it rides tonight's train.
    - Jev input: fleet translates untranslated-Indic `en` BEFORE de-id and reports the count. If it is >20 turns, surg-deid adds transliterate-then-scan.
74. **Surgery v3, set A** (9 docs, fleet #231) is accepted as the base.
    - **Q29 context:** grey only the last 5 min before and 2 min after the encounter, with a "show earlier talk" toggle for the rest. The same rule applies to every item.
    - **CT coronary angiograms (Q20, Q29):** V is asked. Fable's default if no answer by 14:00: OUT of the proposal count (non-invasive imaging, not an intervention); keep them as look-alikes.
75. **Set B = more of 21–24 Sep, NOT history** (hist-miner: only ~2 usable anchors by 14:30).
    - fleet re-scans every consult transcribed 21–24 Sep using lx ENCOUNTER bounds, not PQM windows (fleet's own finding: PQM windows under-read, e.g. Q32 0.14 → 0.81).
    - The same frozen wording a29f2224 is used, and the gates are the same.
    - Target: ≥10 items total at ~7:3 by 15:00. If short, launch with what passes the gates, minimum 8 (Fable decides at 15:00).
76. **hist-miner:** finish room mapping for the 49 anchored visits with tape. Hand fleet any usable anchor as it lands, since anchors are gold even if late. The ratio for the historical sets stays 7 anchored : 3 look-alike. Don't stop; the history set feeds tomorrow's round.
77. **hist-bulk moves to the BOX** (already signed in), not gcp-l4.
    - herdr-kit closes the gcp-l4 pane at the sign-in prompt (no V action needed) and starts hist-bulk on eta-lab-t4 with HIST-MINING.md + STT-STACK-PARITY.md as its first prompt.
    - Workers run on the GPU nodes; the orchestrating session can run anywhere.
78. **HIST GPU nodes:** Fable is creating them on GCP (clinical-infra, asia-south1, L4 quota 32) from machine image eta-lab-l4-img-0924. The IPs follow.
    - E2E stays at 1 GPU. Fable asks V whether to request a limit increase from E2E.
79. **Bulk concurrency ≤3 in flight:** the owner is **yoga-drain** (feeder-3), because bulk route jobs still call the Mini router/indic and the Yoga SraVaani (scribe #223).
    - Parity must cover whisper as run twice in bulk (the twin segments + the router's own).
80. **Parity archive cutoff (eta-refuter-2 #229): ADOPTED.** Only windows after 23 Sep 13:18:18 IST are references. The SraVaani version is pinned by file hash.
81. **indic-mt (~853k context):** herdr-kit restarts it FRESH (not resumed) on Sonnet, with a 20-line handoff note it writes first. The same applies to any idle pane over 300k that can't /compact.
82. **Audio on iPhone:** surg-page checks Range/206 on the page files after Fable publishes v3 (from a signed-in browser via a Sonnet browser agent). If Range is unsupported, it switches the player to fetch → Blob URL (whole MP3 ~10–25 MB) so iOS can play it.

## V ruling 12:10 (supersedes the ruling-74 default)
- **V: "yes, ct angio counts."** CT coronary angiograms (Q20, Q29) COUNT as procedure proposals.
- Scope rule going forward: diagnostic procedures that are booked and done in a procedure/imaging suite (CT angiography and similar) are in scope alongside operations and interventions.
- fleet: re-score the set-A share with Q20 and Q29 IN. eta-refuter-2: apply this in the blind judging (the proposals side moves from 4/9 to 6/9).
