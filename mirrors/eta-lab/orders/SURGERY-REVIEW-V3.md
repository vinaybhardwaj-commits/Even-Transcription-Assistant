# SURGERY REVIEW v3: find real surgical conversations (Fable, 24 Sep 10:55 IST)

V's verdict on the v2 pilot: "You're still not really identifying surgical conversations intelligently." Score: studies/2026-09-24-surgery-v2/V-PILOT-SCORE.md. The P01 answer is now fixed to discussed = yes: it was mentioned, not proposed.

## V's definitions (binding)
- **Surgical conversation:** the doctor names a specific procedure AND describes what it involves or how it will affect the patient. A keyword alone never counts.
- **Scope:** any procedure, with HIGH focus on operations (theatre, anaesthesia) and interventions (angiography/angioplasty, endoscopy, biopsy, injections, anything booked into a procedure room). Minor OPD procedures count, but make up ≤20% of the set.
- **Set mix:**
  - ~70% real proposals: proposed NOW for THIS patient.
  - ~30% look-alikes: history (P05 angiogram), referral, "mentioned but not proposed" (P01).
  - Controls with no procedure talk are not needed.

## Selection (owner fleet; lx supports boundaries)
1. **Truth anchor.** From Metabase, find patients with an OT/procedure booking or a procedure admission ≤30 days after an OPD visit with the same doctor.
   - Locate that consult in the room tape using lx arm d (energy cuts inside the doctor's queue span).
   - Keep it only if the transcript contains the booked procedure or a spoken synonym. Use a lexicon of booked procedure names mapped to spoken terms, including Hindi/Kannada/Latin-script variants.
   - These are the anchored positives.
2. **Jev scan (two stages) over every consult with a transcript** (21–24 Sep and every new day):
   - (a) Recall: "Does the doctor name a specific procedure and describe what it involves or how it will affect the patient?"
   - (b) Status: now-for-this-patient / already done / referred elsewhere / mentioned only.
   - Anchored positives that Jev misses are the most valuable items. Always include them.
3. **Boundaries.** Each item is ONE whole encounter (arm d). Talk outside the encounter (the P02 private staff talk) is shown greyed as "before/after consult" and not scored.
4. **Selection gate before seeding.** Report what share of the selected items are real surgical conversations by V's definition. Score it on consults V has NOT labelled.
   - V's 23 labels (18 v1 + 5 v2) are for developing the wording ONLY.
   - Tuning the wording on V's labels and then scoring on the same labels is leakage. eta-refuter-2 checks this.

## Questions v3 (owner surg-page; skip logic)
1. Is a specific procedure named? → which one (text), plus category: operation / intervention / minor.
2. Is it described (what it involves or its effect on the patient)?
3. Status: proposed now for this patient / already done (history) / referred elsewhere / mentioned only.
4. Who raised it: this doctor / another doctor / patient or family / unclear.
5. How firmly (only if proposed now).
6. Patient's response (only if proposed now).
7. Cost discussed? 8. Second opinion?

- Questions that don't apply are HIDDEN, not answered "not applicable" (P02/P04 needed 8 N/A clicks).
- "Why this consult was selected" (booking or Jev) stays hidden until the rater has finished that consult; it is then shown with the reveal.
- Carry forward Version 4's fixes: yes/no Correct auto-fills; Done lists what is open.
- Keep the page's ratings schema backward compatible. v2 ratings stay readable.

## Timeline
- 16:00: fleet delivers the selection method + Jev v3 wording, run on the 23 labelled consults as a development check only; surg-page delivers the v3 page (jsdom plus one real-browser check via a Sonnet browser agent); surg-deid de-identifies as before (roster whitelist, own doctor kept).
- After tonight's backlog: fleet selects 10 new consults (7 proposals + 3 look-alikes) from 22–24 Sep that nobody has labelled. Fable seeds them by 08:30 on 25 Sep. V plus 1 second rater label them.
- Audio: evidence turns ±3 s as before, served as page files.

## Do not
- Put patient text in git.
- Reseed the live page yourself. Fable publishes and seeds.
- Use the words "surgery"/"operation" as a selection filter by themselves.

## Addendum 11:05: second rater's feedback (binding)
Second rater (reviewing on a phone, inside Slack's in-app browser): "Is there a place I can hear the entire audio instead of just the transcript? … hearing it would be solid."

1. **Whole-consult audio (owner fleet; lab-mover supplies the R2 read key, ruling 55).** One continuous clip per consult, covering exactly the arm-d encounter span.
   - Build it on the box from the raw R2 chunks: download the chunks, cut and concatenate with ffmpeg, then mono 16 kHz → Opus-in-WebM or MP3 at 32 kbps (~15 MB/hour).
   - This does NOT use the Cloudflare join Worker, so it works during clinic hours: the "no joins while rooms record" guard does not apply.
   - Serve it as page files, as today. Keep the per-turn evidence clips.
2. **Player (owner surg-page).**
   - A sticky player bar at the top of the consult: play/pause, ±10 s, speed 1× / 1.25× / 1.5× / 2×, and a scrubber with the consult's time.
   - Tapping any turn's timestamp seeks the whole-consult audio there. The turn currently playing is highlighted and auto-scrolls (with a toggle to turn the auto-scroll off).
   - Evidence chips seek to their turn.
   - Audio must load lazily (on the first tap of play) so the page stays fast on a phone.
3. **Phone first.**
   - The second rater works on an iPhone inside Slack's in-app browser. The v3 page must work at 375 px width: player reachable with the thumb, question rows stacked, Agree/Correct ≥44 px tall.
   - The real-browser check (Sonnet agent) runs at 375 px AND desktop width.
   - Safari plays Opus-in-WebM only on recent iOS, so ship MP3 unless the check proves WebM plays in Slack's iOS browser.
4. **Privacy.** Whole-consult audio is raw patient voice for the full encounter. Fable confirms with V who may hear it. Until then, build it but do not seed it.

## Addendum 11:15: V's rulings (binding)
- **Clearance (V, 24 Sep):** "Sandhya and any future raters are cleared for PHI, they deal with it every day and are even employees (developers)."
  - The privacy hold in the 11:05 addendum is LIFTED. Whole-consult audio ships in v3.
  - The page stays org-internal. Raters are Even employees only.
- **One launch:** V shares nothing until v3 is complete: new design, new consults, whole-consult audio, evidence clips, phone check. Fable hands V a single link. No partial pushes to raters.
- **Speed via Cloudflare/R2 (V):** build the whole-consult audio on Cloudflare, next to R2, as well as on the box.
  - **Path A (owner join-shard, lab infra, NOT the production app):** a new, separate Worker + Container `eta-consult-audio` (ffmpeg image, max_instances up to 10).
    - Input: {session, start_ms, end_ms}. It reads the tape chunks straight from R2 (in-network), cuts and concatenates them, writes MP3 32 kbps mono to R2 prefix `lab/consult-audio/`, and returns the key.
    - Bearer auth; not public. A fresh R2 binding with read on tape and write on `lab/consult-audio/` only.
    - eta-refuter-2 refutes it before its first deploy; a daytime deploy is allowed because it touches neither the production app nor the live join Worker.
  - **Path B (owner fleet): the box ffmpeg path** from the 11:05 addendum, using the ruling-55 R2 key.
  - Run both paths. Whichever produces verified clips first feeds the seed. Cross-check 3 consults: same duration ±1 s, and the audio matches the transcript timestamps at 3 spot points.
- **Target:** v3 complete (page + ≥10 new consults + all audio + phone check + Refuter PASS on the selection) by 08:30 on 25 Sep, sooner if possible. Report blockers to Fable the moment they appear.

## Addendum 11:20: target moved to TODAY 18:00 (V)
- V asked why tomorrow. The only real dependency was a large enough pool of transcribed consults that nobody has labelled. The daytime backlog on the twins (after the 12:30 deploy, ≤3 in flight) supplies that this afternoon, so do not wait for tonight.
- fleet: by 11:45, report the unlabelled consults available NOW with transcripts, by day (21–24 Sep), and how many the Jev scan flags. If ≥10 qualify from the existing pool, select from it immediately and do not wait for the backlog.
- Every lane works in parallel from now:
  - selection (fleet);
  - page v3 (surg-page);
  - de-id (surg-deid);
  - audio Path A (join-shard) + Path B (fleet);
  - boundaries (lx);
  - leakage check (eta-refuter-2).
- Milestones:
  - 14:00: page v3 in jsdom + R2 keys minted + first whole-consult clip.
  - 16:00: selection done + de-id done.
  - 17:00: audio for all items + phone check.
  - 17:30: Refuter PASS.
  - 18:00: Fable seeds and hands V the link.
- If a lane slips, report it the moment it happens. Fable re-plans; nobody silently waits for tonight.

## Addendum 11:25: target moved to 16:00 (V: "lean on the cloud harder")
Critical path = page v3 build + phone check + Refuter. Compute is NOT the bottleneck for those. So:
1. surg-page: build ONLY the v3 deltas on top of Version 4, in this order:
   - (a) skip logic + new questions;
   - (b) sticky whole-consult player with tap-to-seek;
   - (c) phone layout;
   - (d) hidden-until-done "why selected" reveal.
   jsdom check at each step. The page is DONE at 14:30. A Sonnet browser agent runs the real-browser check (375 px + desktop) 14:30–15:00.
2. Audio: Path B (box ffmpeg) is PRIMARY for 16:00. It starts the minute the R2 key exists. join-shard mints the keys NOW, before anything else (by 12:00).
   - Path A (Cloudflare Worker) continues, but does not gate 16:00.
3. Backlog: lean harder.
   - Raise daytime bulk concurrency from ≤3 to ≤6 in flight across the box T4, gcp-l4 and c3 twins (production Mini untouched).
   - If fleet's 11:45 count is short of 10, lab-mover spins up one more E2E GPU node for whisper bulk (V: credits are not a constraint) and adds it to the bulk pool.
4. Selection + de-id: done by 14:30 on the existing pool if ≥10 qualify.
5. Refuter (eta-refuter-2): 15:00–15:30. Fable seeds and hands V the link at 16:00.
- Fallback: if the pool is short at 11:45, the target becomes 18:00 with the backlog feeding it. Report immediately.
