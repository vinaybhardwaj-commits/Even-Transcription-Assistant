# RULING — V, 20 Sep 2026 — durable voice centroids, no proxies

V's words: *"We have to develop durable centroids for doctors voices and not use any other
proxies."* This is a design decision, it is his to make, and it is now the spine of the programme.
Every pane should read this before its next task.

## What is now OUT as ground truth
- The September OPD roster. It is undated (one Mon-Sat template), invisible to leave, swaps and
  cover, and the refuter showed the agreement figure swings ~3x on the choice of denominator.
- `room_day.doctor_id` — exists in our schema, **NULL in all 106 non-scratch room-days**.
- The patient queue system. Dropped: the clips are in R2, and the queue's doctor-room binding is a
  static single-valued map that provably cannot represent a Saturday where two doctors work more
  than one room and eight of nine staffed rooms hold more than one doctor.
- Room slug or room name. Note `room_4ggnkg5x` has the slug `opd-5-dr-salanki-wxmp` — the room is
  named after the doctor v3 measured. Circularity check is with the Refuter; regardless, room
  identity must not enter a voice decision.

## The one distinction I am drawing, and V should correct me if he means it harder
The roster may still be used to **find candidate audio to play to V** — a search hint, nothing
more. **V's ear is the label; the roster is never the label.** The cost is selection bias: we will
never discover a doctor was somewhere unrostered. For building enrolment material that is
acceptable. For measuring accuracy it is not, and it will not be used that way.

## What "durable" has to mean, concretely
1. **Rebuildable.** Today six of seven prints keep no audio, so they can never be recomputed
   against a better model. That is the opposite of durable and it is the highest-priority fix.
2. **Room-domain.** Every match is against a mic across the room. Enrolment must come from the
   same acoustics. Evidence: the one print with a stored duration, 121.4 s, matches at **0.908**;
   short near-field prints sit at **0.535**, below the 0.65 room threshold.
3. **Long enough.** The 3 s / 30 s floors are a placeholder argued from two points. Grounding them
   is now real work, not a footnote.
4. **Versioned.** A centroid must record what produced it, so a model change is a recompute and
   not a re-enrolment of 25 people. Check what migration 0108 `voice_print_generation` already
   gives us.
5. **Multi-sample.** One sample per clinician is the current state for five of seven.

## Order of work
A. Land retention + duration + atomicity (built, in refutation).
B. Roll call: V labels room-domain audio per doctor.
C. Build centroids from labelled audio.
D. **The measurement that grounds everything:** with retained audio, vary sample count and
   duration, rebuild centroids, score against real room turns. This turns the 30 s guess into a
   number and tests the room-domain hypothesis directly.
E. Re-run speaker ID with the new centroids and measure.

D is the point of the whole thing. It only becomes possible once A lands — which is why A is not
housekeeping.

---

## RULING 2 — V, 21 Sep 2026 — harvest only, multi-centroid, login allowed for narrowing

1. **Harvest only.** V: *"Let's just stick to harvesting."* No special enrolment recordings from any
   doctor. Voiceprints are built only from audio ETA has already captured.
2. **Multi-centroid.** V: *"We need to build a multicentroid profile on each doctor so we can allow
   them to use the ETA on their phones as well."* One centroid per doctor **per acoustic domain** —
   room (TONOR, across the room) and phone (near-field) at minimum — with matching using the one that
   fits the audio.
3. **Login allowed for narrowing.** V, asked whether a doctor's own login counts as a proxy: *"Yes. The
   login is allowed."* Precisely what that permits:
   - The login may decide **which sessions to look in** for a doctor's phone voice.
   - Within those sessions, the doctor is identified **by voice**: the one speaker recurring across the
     doctor's sessions while patients change.
   - The login is **never** the label on its own. A voice is only attributed to a doctor when it recurs
     across that doctor's sessions. A session where no voice recurs contributes nothing.
   - This ruling covers **phone sessions**. It does not reopen rosters, room bindings, room slugs or
     queue data as ground truth for **room** audio — those stay out (Ruling 1).
4. **Jev as well, where it works.** V: *"But we will also go the Jev way if we can."* So phone
   voiceprints use **two independent signals**: (a) the voice recurring across a doctor's
   login-narrowed sessions, and (b) Jev judging from the transcript which speaker is the clinician.
   Where both agree, confidence is high. Where they disagree, the segment is held out and flagged,
   never used. Jev is subject to its usual limits — text only, English (translate first), and
   benchmarked on labelled data before it drives anything.

---

## RULING 3 — V, 21 Sep 2026 — ALL signals and proxies allowed. SUPERSEDES the "no proxies" line of Ruling 1.

V: *"I want all possible ways of matching doctors' voices, any proxy you can use."*

Rosters, room slugs, room bindings, the September OPD schedule, phone login, PIN attestation (0109),
Jev role signals, transcript self-identification, voice recurrence, and V's ear are **all allowed**.

### The engineering rule that makes this safe (Fable's, not V's — V may overrule)
**Proxies propose; voice disposes.** Proxies conflict: the roster puts two doctors in one Saturday
slot; the static room map holds one room per doctor; a login labels a session, not a voice. A single
proxy used alone as the label for a **permanent** centroid would poison it. So:
- Every proxy is a **signal** with a recorded source, never a label by itself.
- A voice segment is attributed to a doctor only when **at least two independent signals agree** and
  the voice itself is **consistent** with that doctor's other attributed audio.
- Disagreement → **held out and flagged**, never silently resolved.
- Every attribution stores **which signals produced it**, so a signal later found unreliable can be
  withdrawn and its centroids rebuilt. That is what "durable" requires.

Ruling 1's other requirements stand unchanged: rebuildable, room-domain for room matching, long
enough, versioned, multi-sample.

---

## CONSTRAINT — V, 21 Sep 2026 — the room recorder has NO interface

V: *"That PIN check-in will not happen at the OPD kiosk. That PIN check-in only happens when the doctor
is using the scribe on the phone. Not in the OPD or OT. The room recorder has NO INTERFACE."*

- **PIN attestation (migration 0109) is a PHONE-domain signal only.** It will never exist for room audio.
- **Room audio is purely passive.** No check-in, no tap, no PIN, no confirmation, now or later. No design
  may assume a doctor interacts with a room recorder in OPD or OT. Any proposal that needs one is invalid.
- Room-domain signals are therefore limited to: voice recurrence, the September roster, room slugs,
  Jev role judgements on transcripts, names spoken in the conversation, and V's ear.
- Phone-domain signals: PIN attestation, login, voice recurrence across the doctor's sessions, Jev role.
  The phone side has more independent signals than the room side and should be expected to reach
  usable voiceprints first.

## ERRATUM (Fable, 2026-09-21)
§2's "121.4 s matches at 0.908" is withdrawn — the same print measures 0.594 single / 0.472 cluster (ledger, lx). The room-domain requirement stands on the S2b numbers: 2 of 7 prints clear 0.65; the room-audio rebuild is 0.854 vs 0.834 (n=4).

## RULING 4 — where multi-centroid lives (Fable, 2026-09-21)
Do not reshape 0108. When centroids are built, they go in a new `voice_centroid` table keyed (clinician_id, domain IN ('room','phone'), generation), with per-row provenance (the signals used and the source sessions). 0108 stays the audit history of prints. NOTHING is built until (a) the speech gate lands and (b) lx's harvest shows the room↔phone gap is real. If phone ≈ room, one centroid suffices.

## DECISION (V, 2026-09-21) — translation route for Jev
Local, overnight. Room audio is transcribed and translated on our own machines (Mini/Yoga: whisper, IndicConformer, SraVaani, and qwen via the router with translate:true). Sarvam cloud is not used for this. Transcribe only windows the speech gate marks as speech.
