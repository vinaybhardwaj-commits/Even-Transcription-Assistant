# HIST-MINING: mine historical room audio for surgical conversations (Fable, 24 Sep 11:35 IST)

V: "to mine for consults why don't we spin up more cc sessions on the cloud machines and process more historical audio in parallel". Credits are not a constraint (V).

## Facts (Fable, measured 11:33)
- The R2 READ key is live: box `~/.claude/secrets/r2_audio_read` (line 1 id, 2 secret, 3 endpoint; 0600).
  - Verified: it lists bench/ and is write-DENIED. Python venv with boto3 at `~/.venv-r2`.
  - Never print it; never put it on argv. Copies go to c3/gcp-l4 only via ssh stdin, 0600.
- Bucket eta-audio bench/: 13,506 objects, 15.7 GB. Aug ≈ 921 chunks, Sep ≈ 12,584 chunks. That is roughly 1,000+ room-hours (the estimate assumes ~5 min per chunk).
- Why history matters: visits from Aug to mid-Sep ALREADY have their OT/procedure bookings in Metabase, so they give the strongest truth-anchored positives. This week's visits mostly do not yet.

## Two stages, run in parallel
**Stage 1: targeted (feeds the v3 surgery set TODAY). New CC session `hist-miner` on the box.**
1. From Metabase, find every OPD visit from 1 Aug to 20 Sep followed by a procedure/OT booking or procedure admission ≤30 days later with the same doctor. For each, get the room, day and queue time.
2. Map each visit to the room tape: the R2 chunks covering the doctor's queue span ± 10 min; boundaries via lx `encounter_bounds.py` (PQM-bounded where arm d can't cut).
3. Transcribe ONLY those windows, plus a matched look-alike sample (same doctors and days, no booking) at 3:7 against the anchored set.
   - Engines: the lab twins' whisper + diarize + embed in bulk mode, on the NEW GPU node(s) below, not the daytime backlog pool.
4. Hand fleet the items with transcripts + bounds + booking truth. fleet runs the v3 Jev scan and selection.
   - eta-refuter-2's disjointness gate applies: token_uid AND time vs V's 18.
- Target: first anchored items to fleet by 14:30, so they can make the 16:00 set.

**Stage 2: bulk corpus (background, 24–36 h). New CC session `hist-bulk` on gcp-l4.**
- Queue every Aug–Sep room-day not yet transcribed by the current pipeline, oldest first. Run it through the same engines on dedicated GPUs.
- Output goes to the LAB store (box `~/eta-data/hist/` + a manifest), NOT the production DB. Promotion into production is a separate Fable ruling.
- Pace it so the production Mini is never touched. Clinic-hours bulk uses only the lab machines.

## Capacity (owner lab-mover)
- Provision 2 more E2E GPU nodes now (the largest available of L4/A100/L40S; T4 only as a fallback). Clone the box's whisper/diarize/embed setup (the twins' recipe).
- Add them to a `HIST` pool that is separate from the daytime bulk pool.
- Report node names, GPU type, the ₹/h and throughput (audio-hours per wall-hour) per engine after a 10-min benchmark.
- c3 (CPU) takes embed/emotion for hist.

## Sessions (owner herdr-kit)
Create two CC sessions, labelled "name · purpose · machine", each starting from this file:
- `hist-miner · Stage-1 truth-anchored mining · eta-lab-t4`
- `hist-bulk · Stage-2 Aug–Sep corpus · gcp-l4`

Register both with the conductor and the board. Workers on the GPU nodes are scripts, not CC sessions. One CC session per stage keeps ownership clear (never two sessions editing the same file).

## Do not
- Put patient text/audio in git.
- Print secrets.
- Use the production Mini during clinic hours.
- Write into the production DB.
- Touch V's 18 labelled consults except as the exclusion list.
