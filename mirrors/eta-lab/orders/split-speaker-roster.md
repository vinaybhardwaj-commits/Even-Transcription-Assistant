# ORDER — split-speaker — the roster is ground truth, and it costs nobody's ears

## What just changed
V produced the September OPD schedule: **`/Users/vinaybhardwaj/Desktop/SEPT 2026 OPD Schedule.xlsx`**
(one sheet, weekday blocks, six rooms across the columns, each room a time-slot / doctor pair).
**19 Sep 2026 was a Saturday.** I read the Saturday block myself:

- **ROOM 3** — 9–11AM Dr Animesh (walk-in); **11AM–2PM Dr Animesh / Dr Rakshitha (ENT)**;
  3:30–6PM Dr Sajeet Nayar; 6–7PM Dr Animesh (remote TC).
- **ROOM 5** — **11:30AM–1:30PM Dr Prabhudev Salanki (Uro, walk-in); 1:30–2PM Dr Prabhudev
  Salanki (Uro, TC)**; 2:30–5PM Dr Vishal Naik.

Now compare with what the matcher claimed, with no knowledge of this file:
- v2 claims (Dr Animesh, room_87frpus9): **11:15:53 – 12:36:43** — inside his rostered block.
- v3 claims (Dr Salanki, room_4ggnkg5x): **11:30:02 – 13:58:23** — his block opens at 11:30:00.
  **Two seconds.**

That is independent corroboration of both runs from a document the system has never seen. It also
explains V's answers to the opening questions: Room 3's 11–2 slot is **shared with Dr Rakshitha**
(he said "yes, someone else consulted"), and Room 5's is **Salanki alone** (he said "not sure").

## Goal
Turn this into a measurement over **all 957 claims**, not 54 clips. No listening.

## Steps
1. **Establish the room mapping and do not assume it.** I believe `room_87frpus9` is OPD 3 and
   `room_4ggnkg5x` is OPD 5, but that is inference from earlier counts. Prove it from the room
   table. If a room id cannot be mapped to a schedule column with confidence, exclude it and say so.
2. **Parse the schedule** into (weekday, room, start, end, doctor-name(s)). Note the merged and
   shared cells — "Dr Animesh/ Dr Rakshitha" is two doctors in one slot and must be modelled as
   such, not as a string. Match names to `clinician_id` via the voiceprint table; report any
   rostered name with no voiceprint, and any enrolled clinician absent from the roster.
3. **Cross-check every claim:**
   - claims **inside** the named clinician's own rostered slot → corroborated
   - claims naming a clinician **not rostered in that room at that time** → suspect; this is the
     real false-positive signal and it needs no ear
   - claims inside a **shared** slot → ambiguous by construction; report separately, never folded
     into either bucket
   - **unnamed** turns inside a slot where exactly one doctor is rostered → misses
4. Report per clinician and per room: n claims, corroborated, suspect, ambiguous, and the
   same for misses. Counts only.

## The constraint you must hold, and I want you to police me on it
**A roster is a plan, not an attendance record.** Doctors swap, run late, finish early, cover for
each other. A claim outside a slot is *not proven wrong* — it is unexplained. Say "consistent" and
"unexplained", never "correct" and "false positive", and if the suspect bucket is large, treat
"the roster is stale or routinely departed from" as a live hypothesis with at least equal standing
to "the matcher is wrong". If you think this whole approach is weaker than I am presenting it,
say so plainly — I would rather hear it now than after I have told V we have a number.

## Not allowed
- Do not print transcript text, patient information, or clip content. Counts, ids and clock times.
- Do not cut clips or start a server. The three pilot servers stay up and untouched.
- Do not silently drop a room or a slot you could not parse — list every exclusion.

## Output
The per-clinician and per-room tables, the exclusions, and one paragraph on whether this method
is sound enough to replace listening tests. **CAP 400 words.** Working detail to
`docs/handoff/scratch/`.
