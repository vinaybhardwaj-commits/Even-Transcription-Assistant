# Monitoring surface and voice identity — PRD v1.2

**24 August 2026 · production `6594170` · migrations `0065`**

**Supersedes v1.1 and v1.0 of the same date, completely.** Build from this one. The change from
v1.1: a patient holds a **set of voices**, not one voiceprint; roles are inferred from how often a
voice recurs rather than decided at write time; matching splits into confirm and search; and the
signatures move to storage that can actually be searched.

**STATUS · 24 August, end of afternoon**

- **Decisions: all settled.** 29 of them, D1 to D29 in §2. Nothing open. §17 has the detail.
- **Mockups: built.** `ETA-MONITORING-SURFACE-MOCKUP-24-AUG-2026.html`, awaiting V's approval.
- **Pre-flight: not yet run.** §15. It uses tape we already have and it can void three slices.
- **Not a kickoff yet.** The kickoff is written once V approves the mockup and the pre-flight
  passes.

---

## 1. What this is for

An operator away from the rooms should be able to tell within ten seconds whether each room is
capturing a real consultation, know who is in it, and hear it if the answer is unclear. The same
machinery that answers "who is in the room" is what puts a name to a returning patient.

---

## 2. Decisions

Ratified by V on 24 August. Settled. A builder must not reopen them.

| # | Decision |
|---|---|
| **D1** | Listening in means **true live**. Playback of a saved piece is not the deliverable. |
| **D2** | An operator may listen while a room is recording. Reverses a stated non-goal, on V's authority. |
| **D3** | **No record is kept of who listened.** |
| **D4** | Diarization must run on **room audio**, not only the phone app's encounters. |
| **D5** | The doctor clock is **hidden** until something real feeds it. |
| **D6** | A microphone is judged by **what its pieces contain**, not only how recently one arrived. |
| **D7** | Stranded audio is shown in **minutes**. |
| **D8** | Everything computed and discarded gets **shown**. |
| **D9** | Every open bug touching this surface is folded in. |
| **D10** | **Identification runs live; diarization runs in batch.** Two jobs, two speeds. |
| **D11** | The clock gets two successors: *heard in this room*, from live identification; and a real clock when the Pulse feed exists. |
| **D12** | **Voices are named from recordings already made.** Formal enrolment drops to optional. |
| **D13** | A person may hold **more than one voiceprint** — close-microphone and room-microphone — and a match is only ever scored within the same kind. |
| **D14** | **Patient voices are in scope and are kept.** Consent is taken at registration and biometric data belongs in the chart with everything else recorded about a patient. |
| **D15** | A patient link is **a claim that earns confidence**, not a fact on first sight. |
| **D16** | **The Pulse event feed is in scope.** Its first task is not code. |
| **D17** | Nothing is built on room voices until the **pre-flight in §15** passes. |
| **D18** | Live identification and live listening **share one transport**. Build it once. |
| **D19** | **A patient holds a set of voices, not a voiceprint.** Every non-staff voice around an encounter joins the patient's set. Nobody decides which one is the patient. |
| **D20** | **Never average a set.** Six voices averaged make a vector matching nobody. Each member stays its own signature, and a match means close to *one member*. |
| **D21** | **Roles are inferred from recurrence, not asserted.** A voice recurring across many unrelated patients is staff. A voice recurring for one patient is the patient or a constant carer. A voice appearing once is that day's attender. |
| **D22** | **Matching has two modes.** *Confirm* against a known patient's set. *Search* across everybody, which needs a higher bar and a margin between first and second place. |
| **D23** | **Signatures move to searchable storage.** Kept today as raw bytes, which cannot be indexed or compared in the database at all. |
| **D24** | **Live audio runs through a relay at Cloudflare.** The room Mac sends pieces to it; it passes them to the operator's browser to hear and to the Mini to identify. It stores nothing. Chosen over the Mini, which is already the bottleneck, and over a direct browser-to-browser link, which would serve listening only. |
| **D25** | **The database does the matching and ranking.** The voice service turns speech into a signature; the database finds the nearest voices with an index and returns the top few with their distances, so the margin between first and second comes back in the same answer. No signatures travel over the wire. |
| **D26** | **Room windows get their own job record.** The phone app's diarization path is not touched. Two shapes, and the working one is left alone. |
| **D27** | **Build order: 1 and 2 first.** Fix the false alarms and add the level bars, then the voice-service panel, batch diarization, the naming screen, live identification, the relay and listening, the Pulse feed and patient sets. The pre-flight in §15 runs immediately and in parallel, because it can void three slices. |
| **D28** | **Four of the 24 stranded windows are transcribed first.** Read the output before paying for the other twenty. |
| **D38** | **An idle room reports itself every 3 seconds; the 10-second freshness window is unchanged.** Three chances to be heard before it is called gone. While recording, the existing cadence stands. |
| **D37** | **The main microphone is dead only when the device is gone, or when two consecutive full-length pieces come back tiny while the meter heard sound.** Both are evidence. **The silence watchdog is not used for this decision at all** — it produced two false alarms in one morning and bound sixteen windows to a spare. |
| **D36** | **A microphone is called faulty on size only when the level meter heard sound during that piece.** A quiet room making small pieces is quiet, not broken. Both halves ship in Build 2 so they check each other, and it is the only version that cannot cry wolf on a slow afternoon. |
| **D35** | **The build ships in three parts** — the page, then the room and the tape, then the recovery control. §17 carries the split and what gates each one. |
| **D34** | **Today's wrongly bound windows are re-bound to the main microphone and re-run.** Sixteen of Cardiology's twenty are bound to the spare because of a false alarm. They are not transcribed as they stand. |
| **D33** | **A window binds to the main microphone unless the main is proven dead AND a spare is proven healthy.** Never on a flag alone. The flag that bound today's windows to the spare was false, and nothing ever cleared it. |
| **D32** | **The main microphone is the source of record. A spare is optional and often absent.** V, 24 August: the Mini at home has only one microphone, the clinic rigs have a second only when a webcam happens to be plugged in, and that is not true of every room or every day. Nothing may assume two microphones exist. A room with one microphone is a normal room, not a degraded one. |
| **D31** | **Every remote control must be two-way.** If an operator can stop a room from the desk, the operator must be able to start it again from the desk. A one-way control is a trap and does not ship. Where a control cannot yet be undone remotely, it states that before it is used. |
| **D30** | **A room that has finished for the day gets its own state, and the heartbeat keeps running while the page is open.** Ending a day must never read as a fault. This adds a seventh room state and overrides the standing instruction in §12 to leave the six-state pill alone — named here so it is a decision rather than a builder's improvisation. |
| **D29** | **Pulse data comes through Metabase now, a direct account later.** Scribe gets a Metabase key and copies the client CDMSS already uses against database 13. If a read-only account on the mirror ever appears, the source is swapped underneath; the event shape does not change, so nothing downstream moves. |

---

## 3. Slice 0 — Stop the page lying

First, because everything else is worth less on a page that cries wolf.

### 3.1 The doctor clock — hide, then replace (D5, D11)

Nothing in production writes clock events; the only writer is a command run by hand against a
spreadsheet. With no event, the code silently falls back to the time recording started — so the
number is the length of the recording wearing the label of a clock gap, and every room turns red
thirty minutes in. The screen and the operator door disagree, because only the screen falls back.

**Now:** remove the row, the pill and the alarm. Delete the fallback on both sides.
**Successor one:** *heard in this room* — "Dr Salanki, heard 40 seconds ago" — from §7.
**Successor two:** a real clock, when §10 lands. The two then sit side by side: one says who is
talking, the other says who is working.

Wording rules stay. Nothing may say "warehouse silent" or imply the hospital system is down.

### 3.2 A microphone that comes back must be seen to come back (D6)

Two faults, one symptom. The watchdog compares two moments against the wall clock rather than
counting samples, and each reading is about eleven milliseconds — shorter than a pause between
words. And **nothing ever clears it**: there is no restored event, so a room reads as being on its
spare microphone all day. Both clinic rooms today showed lost with no restore while full-size
pieces kept arriving. It matters beyond the display: that event is one of two inputs that later
decide which microphone's audio to serve.

Build: emit **restored** when a following piece arrives at a healthy size; require consecutive
evidence and reset when a sample is skipped; judge by size as well as age.

**Size cannot be an absolute floor and cannot rely on there being two microphones (D32).** Measured
per five minutes: 4.83 MB on Home Office, 8.2 MB on both clinic rigs. Judge each microphone against
**a baseline learned from that room's own recent pieces on that same microphone** — a rule that
works on a room with one microphone, which is the normal case. Where a second microphone genuinely
exists, the ratio between them is a useful extra signal, never the primary one.

Exempt the last piece of a session; a flush piece is legitimately 27 KB.

Freshness stays. Size is added beside it.

### 3.3 A session's end time must be the end of its audio

`bs_f46u4jxw` on OPD 5 has a stored end more than ten minutes after its last piece. Half this
class was fixed on 23 August; nothing repairs an end time that does not match the tape. Set it
from the last verified piece, on the normal path and on reload and resume. Repair the wrong rows,
including the stale one on `bs_jmh9jxmx`. **Verify first** whether `bs_f46u4jxw` predates the two
related fixes.

### 3.4 Stranded audio in minutes (D7)

Four ways audio strands and the page distinguishes one: no day record (handled well — its wording
is the model, do not invent a third vocabulary); windows closed while Transcript was off; windows
bound and drainable but never drained, 24 on one session; and slots never covered from their first
instant, measured at 3.2 seconds late on Cardiology, costing a whole fifteen-minute slot.

One figure per room and one for the day: **minutes that cannot currently be turned into words**,
split four ways. Recorded and transcribed are not comparable today — one sums piece length, the
other window span. Make them commensurate or say plainly that they are not. **Reason two's wording
is gated on tonight's switch experiment.**

### 3.5 Show what is already on the wire (D8)

No new queries: last piece per microphone separately; spare-microphone pieces as a number; when
the last mark was pressed; minutes turned into words per room; the thresholds; the per-room
degraded list.

### 3.7 A room that has finished for the day must say so

**What is wrong.** A room that has been ended deliberately falls through the state chain to
**dropped** for ten minutes and **offline** after that, in amber, advising the operator to *reopen
the room page on the clinic Mac*. There is no state for a day that is simply over.

**Why the room goes quiet.** Ending a session stops the page reporting itself. This held on three
rooms out of three on 24 August. Home Office briefly looked like an exception — ended at 09:24 and
still reporting itself seven hours later — until V confirmed he had **reloaded that window by hand
before leaving for the office**. That is his recollection rather than a measurement, and §3.8 part
two turns it into evidence at no cost. **§3.8 is the same defect with teeth.**

Measured 24 August: both clinic rooms were ended deliberately at 16:16 and both ended cleanly. Nine
minutes later both read *"Kiosk dropped 9m ago — it may come back on its own"*, with a listener age
of 558 seconds — exactly the interval since the day ended.

**What to build.**

1. **Keep the heartbeat running while the room page is open**, recording or not. A room that is
   open and idle is a different thing from a room whose page has died, and today they look the
   same.
2. **Add a state: finished for today.** The room's last session ended normally today and none is
   running. It ranks after `paused` and `recording`, before `ready`, `dropped` and `offline`.
   Copy: *"Finished for today · 4h 21m recorded"*, hint *"Press start to record again."* Green or
   grey, never amber.
3. `dropped` and `offline` then mean only what they say — a page that stopped responding while
   there was still something to do.

**And the same fix reaches the sessions list.** It badged a 4h 21m session that ran on its main
microphone throughout as *"on backup mic · 40 chunks"*. That is §3.2's stuck flag appearing in a
second place, and 40 is the count of pieces the spare wrote before it failed. Judge that badge by
piece size too.

### 3.8 The remote control must not be one-way

**The most serious item in Slice 0.** An operator can stop a room from the Bench screen and cannot
start it again. Starting needs the room to be listening, and **stopping is what makes it stop
listening.** Every use of the stop button strands that room until somebody walks to it and reloads
the page.

Measured 24 August, three rooms out of three. Both clinic rooms ended remotely at 16:16; both went
quiet within seconds. At 16:33 Cardiology was listening only because V had walked downstairs and
reloaded it by hand, and OPD 5 had been unreachable for 16 minutes 56 seconds. Home Office looked
like an exception — ended at 09:24, still listening at 16:33 — until V confirmed he had reloaded
that window by hand before leaving. **There is no counter-example.**

**Operating instruction until this is fixed: do not end a day from the Bench screen.** End it at
the Mac in the room. The remote stop works, and that is the problem — it works once.

**A control that can be used but not undone from the same place is worse than no control at all,
because it looks safe.** The cost appears afterwards, in another building. Today it cost one walk
downstairs. In a live clinic it costs a room's morning.

**What to build.**

1. **The page reports itself whenever it is open**, whatever the session is doing. Idle-and-open
   and dead must stop being the same thing. This is also part one of §3.7 — the two sections share
   one fix, and this is the reason it matters.
2. **Prove it on a clinic Mac.** Stop a room remotely, leave the machine untouched, and read the
   room every minute for thirty minutes. Repeat with the display asleep. Until that test exists we
   do not know which of the three machines was the exception today, and the fix is aimed at a
   cause nobody has confirmed.
3. **Until it is proven, the stop control states its cost before it is used.** If stopping would
   leave the room unreachable from the desk, the button says so — not the room card afterwards.

**Done when** an operator can stop and restart any room from the desk, without anyone entering
the room, and that has been demonstrated on a clinic Mac rather than on the machine in V's study.

### 3.9 One microphone is the normal case (D32, D33, D34)

**The constraint.** The Mini at home has one microphone. The clinic rigs have a second only when a
webcam happens to be plugged in, and that is not true of every room or every day. **Nothing in
this system may assume a spare exists.** A room with one microphone is normal, not degraded.

**What went wrong today, and it is the worst thing found on 24 August.** Cardiology's false
"main microphone lost" fired at 12:25. From that moment the window writer bound **every remaining
window of the day to the spare microphone** — sixteen of twenty — and nothing ever switched back,
because nothing clears that flag. The room's main microphone was recording perfectly throughout.

Cardiology's spare happened to be healthy, so the audio behind those windows is real. **On a rig
with no spare, or a spare that writes near-silence, the same fault would have handed four hours of
consultation to an empty microphone and returned nothing, with no error anywhere.** The Home Office
rig wrote 70 KB against 4.8 MB for the same five minutes this morning, and tonight reported no
spare at all.

**Rules.**

1. **The main microphone is the source of record.** Every window binds to it by default.
2. **A window may only bind to a spare when the main is proven dead *and* the spare is proven
   healthy** — proven by piece size and continuity, never by a flag.
3. **A room with no second device has no spare lane.** Do not create one, do not write near-empty
   pieces into one, and do not show a spare vital. A near-empty spare piece is worse than no piece,
   because it looks like a working failsafe.
4. **The absence of a spare is not a fault** and must never raise an alarm or an amber vital.
5. **Today's sixteen wrongly bound windows are re-bound to the main microphone and re-run** (D34).

### 3.10 A way to run the waiting audio (D34)

**What is wrong.** Turning Transcript on does not queue anything. Proven tonight: all seventeen of
Cardiology's finished windows show no job against them. The card says "0 done, 17 waiting" and its
attention row offers to make it "stop trying" — **nothing is trying, nothing is queued, and there
is no control anywhere on the page that would run them.** The only way to process them is to call
an admin web address by hand, one window at a time. That is how the one window was recovered
tonight: 5,468 characters, Sarvam, 23 seconds.

**What to build.**

- A control on the room card: **run this room's waiting audio**, with how many windows and a
  reminder that each one is a paid call.
- It processes finished windows that have no job, oldest first, in batches small enough to finish
  inside one request.
- It reports what it did and what it cost, per window.
- Copy fix: a lane with finished windows and no worker says **waiting for someone to run it**,
  never "waiting to be turned into words", and never offers to stop something that is not running.

### 3.6 Make the screen and the door agree

The screen has the end-time alarm, the door has its mirror image, neither has both. The door does
not report the two switches at all, so an automated watcher cannot warn that a room is recording
into nothing. **One shared source for every room fact, used by both.**

---

## 4. Slice 1 — See who is speaking

The level meter. Best value here, because the measurement already exists and is thrown away once a
second. The chain is complete and running: measured every second in the room, a channel to the
server every 1.5 seconds, a one-row-per-room table written on each, read by the operator page
every three seconds. One number has to ride it.

Send the **highest and the average** since the last report, not the raw snapshot — an
eleven-millisecond sample reads zero between two words. One column per value. A bar per microphone
**that actually exists on that rig** (D32) — most rooms will show one bar, and a room with one
microphone says nothing at all about a spare: no empty lane, no grey placeholder, no amber vital.
Where a second device is genuinely present, show a second bar. Today only the main one is measured,
which is why nobody noticed a spare recording nothing for weeks.

Hazards: on iPhone browsers a recorder and an analyser cannot share one microphone track; the room
Macs are unaffected but the phone app must not copy this. And the added field must never make the
poll fail — that poll is the command bus and fails open for the doctor by design.

Gives §3.2 its restore signal for free, and makes a false silence alarm visible.

---

## 5. Slice 2 — Hear the room (D1, D2, D3, D18)

**Pre-flight first, and it can fail.** A second recorder on the same microphone alongside the
archive recorder. That code exists, has never been switched on, and its go/no-go was never taken.
Run a room thirty minutes with it mounted and prove the archive is untouched — same pieces, sizes
and gap total as a control. **The archive always wins.**

**Transport (D24).** No route accepts audio while it is being recorded. The room Mac sends pieces
to a relay at Cloudflare, which passes them to the operator's browser and to the Mini. It holds
nothing. The same pipe serves live identification (D18) — build once, get both. Cloudflare is
already in the stack for joining audio, sits near the rooms, and does not depend on the Mini being
free.

**Stored:** nothing. **Recorded about the listener:** nothing, per D3. **The doctor sees nothing.**

---

## 6. Slice 3 — Show what the voice service is doing

All of this exists and is displayed nowhere. Is the machine up, which models, how fast it
answered. Is its single slot busy and who holds it — the function exists, is documented as being
for operator visibility, and has no callers. **The last runs with their time split into waiting,
moving the audio, and the model working** — stored on every run, rendered nowhere, and the highest
value item here because it separates a slow network from a slow model. The budget and its
provenance: five minutes, measured while a nine-hour recording ran on the same machine. Which
voices the system can recognise.

Do not show an empty box labelled "voices in this room" until §8 ships.

---

## 7. Slice 4a — Live identification (D10, D11, D13, D22)

The clock. Mostly built.

Take a few seconds of speech, make a signature, compare against the voiceprints we hold. The
comparison is free — matching fifty people costs the same as one, because the cost is making the
signature. A route already does this every eight seconds on a nine-second slice for the phone app.
It compares against one person because it was written for a doctor holding their own phone.

**Changes.** The query selects every voiceprint of the right kind. The single comparison becomes a
ranked list with a margin between first and second. The answer is a ranking, not a yes or no.

**Two voiceprints per person (D13).** Close-microphone and room-microphone are different things and
are never scored against each other. The store allows one per person today and must change.

**The threshold has no evidence under it.** 0.78 was set one-against-self with no impostor data,
and on room audio it rejects the correct person — a known speaker measured 0.55 to 0.62 against
his own phone-recorded voiceprint, and every real-speech slice came back as "not him". Measure it
per kind before it gates anything. Until then identification reports a ranking and a confidence
and nothing acts on it automatically.

**The vital.** Per recording room: who was heard, how recently, how confident.

**Unmeasured and needed:** nobody has ever timed one voice signature. Get that number before
sizing six rooms.

---

## 8. Slice 4b — Batch diarization and room voices (D4)

The memory. Runs after each window closes and builds what §7 matches against.

Diarization has never processed a second of room audio. It is bound to the phone app's encounters
and those are dormant. There is a table shaped exactly for room voice clusters and nothing writes
to it; a test fails the build if the diarization code names a room table. That test was right when
written; this slice changes it.

**What a run attaches to (D26).** A room window gets its own job record, with its own timing and
error history. The phone app's path is left exactly as it is. The test that fails the build if
diarization names a room table is replaced by a narrower one that keeps the two apart.

**The dispatcher:** a pass taking a closed window, fetching its joined audio, asking the service —
same shape as the transcription drain, with the same manual and scheduled doors.

Three measured constraints, none negotiable. **One at a time across the whole system**; one run
waited 28.5 seconds for 8.3 seconds of work. **Show waiting separately from working**, or the
model appears to have slowed. **The clinical path owns the machine**; room work yields.

Cost: fifteen minutes of audio takes 58 seconds, 42 of it the model. First call after idle adds 12
seconds, once.

**Do not split a window to go faster** — measured and refuted; the service labels speakers per
call. Splitting for incremental results is a different argument.

**Voices accumulate per room-day**, merged across windows so a person speaking in three
consecutive windows is one voice.

---

## 9. Slice 5 — Identity

### 9.1 Staff: the naming queue (D12)

A person opens a voice from a room-day, listens, and names it. The sample joins that person's
room voiceprint, recomputed as the average of everything included. The store already distinguishes
a sample gathered deliberately from one captured in passing, has an include switch per sample, and
recomputes on change. Missing: the human step and the screen.

**Purity is the risk.** If two people merge into one voice and somebody names it, the error enters
a voiceprint and degrades every later match. The reviewer hears the voice before naming it. The
include switch is used, so a bad sample is pulled and the voiceprint recomputed. Show how many
samples a voiceprint rests on and how well they agree with each other.

This also produces the labelled data the accuracy harness has been waiting for. It holds zero
labels today and cannot report anything.

### 9.2 Patients: a set, not a voiceprint (D14, D19, D20, D21)

**The rule.** Every non-staff voice around an encounter joins that patient's set. Nobody decides
which one is the patient. A patient who arrives with five attenders contributes six voices, and
all six are kept.

**Why this is right.** The attender may speak more than the patient or less. A different attender
may come next time. Deciding at write time means being wrong often and never finding out.

**Never average the set (D20).** Six voices averaged make a vector matching nobody. Each member is
its own signature. A match means close to *one member*. Keep a signature per visit as well as any
running average for a member, because a voice changes with a cold, with age, with the respiratory
complaint that brought them in.

**Each member carries:**

- how many visits it has appeared in, for this patient
- how many **different patients** it has appeared for
- first heard, last heard
- share of speech in each visit it appeared in
- the confidence of the visit link that put it there

**Roles fall out of those counts (D21). Nobody asserts them.**

| Pattern | Reading |
|---|---|
| appears for **many unrelated patients** | staff — a nurse, an attendant, a translator, the person who brings the file, or a doctor leaking into the wrong set |
| appears repeatedly for **one patient only** | the patient, or a constant carer |
| appears **once** | that day's attender |

The first row is the valuable one: **it finds staff without anyone naming them**, and it flags a
contaminated set without anyone reviewing it. Promote a high cross-patient voice to the staff
naming queue rather than leaving it in patients' sets.

**A link is a claim that earns confidence (D15).** A first link is provisional and identifies
nobody. A later visit confirms or contradicts it: the same voice on an independently named visit
for the same patient raises confidence; the same voice under a different patient drops both and
queues them for a person. Samples are kept individually so a wrong one can be excluded and the
result recomputed. Nothing drives a clinical decision until it has **two independent
confirmations**.

**Two known sources of wrong links, designed for rather than hoped away.** The labelling heuristic
in the service is duration-based, so a first link should say "a voice from this visit", never "the
patient". And a prescription's timestamp is when it was saved, not when it was said — the fuse
already treats a note as something that closes a consultation rather than opening one, for exactly
that reason. Prefer the start event over the note when both exist.

### 9.3 Matching: confirm and search (D22, D23)

**Confirm — the common case.** Match against this patient's own set. Six candidates. Runs on every
return visit, because registration already says who we think is in the room. Cheap and reliable.

**Search — the uncommon case.** Match against everybody, for when we genuinely do not know.
Accuracy, not speed, is what degrades here: the more people held, the better the chance one of
them sounds like you by accident. Search needs a higher bar **and a margin** — the best match must
beat the second by a clear distance, or the answer is "not sure" rather than a name. A ranked list
with no margin rule is how these systems produce confident wrong answers.

**Storage and ranking (D23, D25).** Signatures are kept today as raw bytes, which cannot be
indexed or compared in the database at all. Move them to a searchable vector type in the same
database, with an index. The voice service turns speech into a signature; **the database finds the
nearest voices and returns the top few with their distances**, so the margin between first and
second arrives in the same answer. No signatures travel over the wire, and it stays fast as the
store grows.

**Scale, so nobody over-engineers it.** A signature is 192 numbers, 768 bytes. At a few hundred
consultations a day with two or three voices each, that is roughly a couple of hundred thousand
signatures a year — a few hundred megabytes, and an exhaustive comparison against all of them
runs well under a tenth of a second. **A plain full comparison is adequate for years.** An
approximate index is available later without redesigning anything, and should not be built now.

**Two correctness details.** Normalise a signature to unit length before averaging — the current
code averages raw vectors, which skews toward whoever spoke loudest or longest. And the threshold
must be measured against impostors, not only against people matching themselves; with sets and an
open search, an unproven threshold stops being merely unproven and becomes actively wrong.

---

## 10. Slice 6 — The Pulse event feed (D16)

Worth more than any single feature here. It names visits, gives a real start and end per patient,
restores a true clock, and is what makes §9.2 possible at all.

**Where the data already is.** All four things we need sit in Metabase database 13, a copy of
Firestore mirrored into a normal SQL database and running about half a second behind it. **There
is no Pulse change to make and nothing to ask of the Pulse team.**

**Why it has never arrived.** Scribe has no Metabase connection and no Firestore connection at
all — its whole world is its own database, storage and the Mini. Every warehouse row that has ever
entered Scribe came from a person pulling a spreadsheet out of Metabase by hand and pushing it in
through Scribe's own door. In August the ruling was that the proper way was a direct read-only
database account, with Metabase's own service treated as fit only for occasional queries. That
account was never created, the build shipped with the hand-pulled file, and the option was never
looked at again.

**What to build (D29).** Give Scribe a Metabase key and copy the client CDMSS already uses against
the same database. A scheduled pull, every minute or so, into the same event shape the manual
loader already writes, so nothing downstream changes. If a direct account ever appears, swap the
source underneath.

The four events: a patient called to consultation; a prescription started; a diagnostic event; a
prescription uploaded. Every one carries the patient. The called event alone also carries the
doctor.

**One measured warning.** The single time this join was tested against real tape, **35 of 43 events
fell outside every recording window.** Part is tape coverage and part is the doctor-room binding,
but it is the only evidence we have: do not assume a time join lands. The existing code already
refuses to filter on the tape window for this reason.

**Build, once the role exists:** a scheduled pull into the same event shape the manual loader
already writes, so nothing downstream changes.

---

## 11. Slice 7 — The backlog, squared away

**Fix here:** the one-way remote control — stop strands a room (§3.8, backlog P6, the most serious
item in this document); a finished room reading as a fault, and the sessions list badging a whole
session as running on the spare microphone (§3.7, backlog P5); the session end time (§3.3, backlog P1); the
false microphone-lost with no restore (§3.2, backlog P2); the
half of the reap fix that repairs an end time earlier than the last piece; the screen and door
divergence including the missing switches (§3.6); the stale row on `bs_jmh9jxmx`; no figure for
stranded audio (§3.4); fields computed and discarded (§3.5).

**From the owed list:** nothing drains automatically — one scheduled pass for transcription and
diarization together; the 24 drainable windows — **four transcribed first, the rest only if the
output reads well** (D28), each being a paid call and the cleanest test material §8 will get; the
step lock's five-minute life is shorter than a worst-case diarization step;
re-measure the diarization budget on a quiet machine before §6 shows it; settle the processor
question with a power monitor before §6 claims one.

**Not here, named so they are not lost:** the drain creating its own day record — the real fix
behind the Mark consult instruction and the only one surviving midnight; the three keyboard jobs,
of which **rotating `claude@even.in` has a clock on it, because its password sat in a build log**;
the speech-engine measurements; the four parked security items.

**Verify, do not assume fixed:** nine bugs carry "pending device retest", none discharged in
writing; two shipped fixes sit behind switches that may never have been turned on in production;
a bug whose heading says open and whose body says fixed, where the page renders the heading; the
two class defects from 19 August, fixed but still marked "fix ratified", in a copy the bug page
has never seen; the room-Mac rule retired by measurement this morning, in a carryover not yet
amended.

---

## 12. What this build must not change

The wording rules on the doctor clock. The abandoned-session repair and the marks row.

**One deliberate exception (D30).** The room pill gains a seventh state, *finished for today*, per
§3.7. That is the only change to the state chain. The six existing states keep their meanings,
their order and their copy — a builder must not take D30 as licence to reshuffle the rest. Freshness on microphones — size is added beside it. The end-time alarm's discriminator,
which compares capture times because the first version fired on every ordinary end of day. The
vocabulary: the lanes are Tape, Transcript and Visits, and the page never says drain, fuse,
subject, or the name of a table. Green means working; on-with-nothing-to-do is grey. Nothing the
clinician sees.

---

## 13. Hazards

**Colours that silently do not exist.** Three times this project has shipped a control whose colour
was undefined in the palette and rendered as nothing. The last made a switch that was on look off,
on the control panel. Every new bar, lamp and alarm must use a defined shade, and **acceptance
requires a screenshot** — the last one was caught by looking, not by a test.

**The false-alarm trap — and it is now four for four.** Every alarm this page has raised in front
of a person has fired on healthy behaviour:

| Alarm | Fired on |
|---|---|
| the end-time alarm, first version | every ordinary end of day |
| the doctor clock | every room, thirty minutes after it starts |
| main microphone lost | two working microphones, twice in one morning |
| kiosk dropped | every room, every time a day is ended on purpose |

Not one of them was ever wrong about its own arithmetic. Each measured something real and drew a
conclusion nobody could act on. **Check every new alarm against an ordinary day before it ships**,
and if it fires on one, it is the alarm that is wrong. An alarm that cries on healthy behaviour is
unread by Wednesday, and the cost is not the noise — it is that the one true alarm on the page
this morning, Cardiology recording an hour with no day record, sat unread underneath two false
ones.

**One failed read silences a different alarm.** The page treats "cannot tell" as unknown, which is
right, but a failed read turns the day-record answer unknown in every room and silences the no-day
alarm. A carelessly added query widens that.

**Depth one.** §8 shares one machine with the live clinical path and with speech recognition.
Queueing several rooms looks like a hang unless waiting is shown separately from working.

**An open search invites confident wrong answers.** See §9.3. The margin rule is not optional.

---

## 14. Open risks carried by V's decisions

Recorded, not argued. **D3** — live audio becomes reachable by anyone with an administrator
session with no trace; consent wording for live listening is still open with the hospital's
lawyer. **D2** — reverses a non-goal stated twice in the monitor's own specification. **D4** —
adds load to a machine the live clinical path owns. **D14** — creates a searchable voice record of
patients; V's decision as general manager, on the basis that consent is taken at registration and
biometric data belongs in the chart.

---

## 15. Pre-flight — before anything is built (D17)

Two windows each from Cardiology OPD and OPD 5 from this morning. Diarize them. Answer four
questions.

1. **Do the voices separate?** Is the doctor distinguishable from the other people in the room, or
   does it come back as one blurred cluster?
2. **Does the same voice come back as the same voice across windows**, matched by signature rather
   than by label?
3. **What does a room-to-room match score?** The same doctor in two windows. That number sets the
   threshold the 0.78 in the code was never measured against.
4. **What does an impostor score?** One person's voice against a different person's. Without this,
   every threshold in this document is a guess.

If room audio will not cluster cleanly, §7, §8 and §9 do not stand up — and we will know it from
tape we already have.

---

## 16. Mockups — BUILT, awaiting V's approval

**File: `ETA-MONITORING-SURFACE-MOCKUP-24-AUG-2026.html`, same folder.** Open it in a browser.
All six screens are drawn, with real numbers from the two clinic rooms between 12:26 and 13:00 on
24 August.

1. The room card: doctor clock gone, two level bars, the size vital, *heard in this room*. ✅ drawn
2. The stranded-audio figure, on the day summary and on the card. ✅ drawn
3. The listen control, and the page while listening. ✅ drawn
4. The voice panel, in both states — before room voices exist, and after. ✅ drawn
5. The naming screen: listening to a voice, naming it, and the block on a voice whose pieces do
   not agree with each other. ✅ drawn
6. A patient's voice set: members, visit counts, cross-patient counts, inferred role. ✅ drawn
7. The **finished for today** card (§3.7), beside the live ones. ✅ drawn

Two things in the mockup are proposals rather than decisions and V should accept or reject them:
a **Voices** item added to the sidebar, since naming needs a home; and the wording of the empty
case on a room where nobody is enrolled — *no voice recognised yet — nobody in this room is
enrolled*.

**Status: awaiting V's approval. This is the only gate left before a kickoff, alongside the
pre-flight in §15.**

---

## 17. Decisions — ALL SETTLED

**Nothing is open. Twenty-nine decisions, D1 to D29, all ratified by V on 24 August, all in §2.**
The six that were outstanding this afternoon — how live audio travels, where the matching happens,
what a diarization job belongs to, the build order, the 24 stranded windows, and how Pulse data
reaches Scribe — were each put to V one at a time and answered. They are D24 to D29.

A builder must not reopen any of them.

### How the build ships (D35)

Three parts, each a separate handover with its own gate. They are ordered so the risky writes come
after the safe reads, and so nothing that touches a live recording ships on the same day as
something that only changes a screen.

| # | What | Touches | Gate before kickoff |
|---|---|---|---|
| **1** | **The page tells the truth.** Hide the doctor clock (§3.1). The finished-for-today state (§3.7). Stranded audio in minutes (§3.4). Fields already on the wire (§3.5). The screen and the door agree (§3.6). Every copy fix, including "waiting for someone to run it". | Read paths and rendering only. No recorder, no writer, no migration that changes behaviour. | **V approves the mockup. That is all.** |
| **2** | **The room and the tape.** The page reports itself whenever it is open (§3.8, §3.7). Level bars, one or two per rig (§4). Microphone judged by size with a per-room baseline, and a restored event (§3.2). The binding rule — main by default, spare only on proof (§3.9). Session end time from the last verified piece (§3.3). | The kiosk, the recorder, the window writer. One migration. | Mockup, plus the thirty-second look at OPD 5's screen, plus a clinic Mini available to test on. |
| **3** | **Recovery.** A control to run a room's waiting audio (§3.10). Re-bind and re-run today's sixteen wrongly bound windows (D34). | The drain, and a new control on the card. | Build 2 shipped, so the binding rule is in place before anything is re-run. |

Slices 1 to 6 of the voice work follow after, gated on the pre-flight in §15.

**So: Build 1 is one approval away from kickoff.** It is the largest single reduction in false
alarms available, it cannot touch a recording, and it can ship while the pilot runs.

**Still open, and neither is a design decision:**

| Gate | State |
|---|---|
| V approves the mockup (§16) | **APPROVED by V, 24 August.** Build 1 kickoff written: `ETA-BUILD-1-KICKOFF-24-AUG-2026.md`, same folder. |
| ~~Look at OPD 5's screen before touching it~~ | **DROPPED 25 August.** V is not at the hospital and the clinic machines will all be reloaded when he next is, which destroys the evidence anyway. §3.8's heartbeat change is right whether the cause was software or the machine — it is just not proof of *sufficiency*. Build 2 no longer waits on it. The room-rig question moves to its own track (§18). |
| The pre-flight on tonight's tape (§15) | Not yet run. Gates the voice slices only, not Builds 1 to 3. |

**Build order (D27), in full:**

1. Fix the false alarms — the doctor clock, the microphone-lost that never clears, the session end
   time that does not match the tape (§3)
2. The level bars, both microphones (§4)
3. The voice-service panel (§6)
4. Batch diarization on room windows, so each room-day has a set of voices (§8)
5. The naming screen (§9.1)
6. Live identification, and *heard in this room* on the card (§7)
7. The Cloudflare relay and listening to a live room (§5)
8. The Pulse feed through Metabase, then patient voice sets (§10, §9.2)

Four must precede five, and five must precede six: a voice cannot be named before it exists, and
nothing can be identified against a voiceprint nobody has named.

---

## 18. Sources

The repository at `6594170`, read directly. The pilot backlog of 24 August; the bug log in both its
copies, which differ; the scoped backlog; the carryover of 23 August; the rooms-live monitor,
room-controls, room speech-to-text, voice-enrolment and warehouse-join specifications; the
diarization timing probe and the far-field probe; the minimised-window test of this morning; and
live readings from the two clinic rooms taken between 12:26 and 13:00 today.
