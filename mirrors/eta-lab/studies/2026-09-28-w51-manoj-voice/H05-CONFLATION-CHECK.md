# W51 CHECK-FIRST: does any H05 anchor come from Manoj C (evening) consults? (lx, 28 Sep)

Order: `/home/eta/oc/W51.txt`-equivalent bus text (Fable, 28 Sep ~10:4x), "CHECK FIRST whether any
H05 anchor came from Manoj C evening consults (name conflation) and report" — before any new
computation. This is a read-only audit of already-existing, already-published data
(`studies/2026-09-24-voice-jev/refute/31-h05-test-result.md`, `link/extension/h05_result.json`,
`~/eta-data/voice-linkage/dtree84/`, `~/eta-data/vj/centroids/`) — no new embeddings, no new
clustering, nothing trained, nothing written to production. Counts/ids/times/cosines only below;
no transcript text.

## H05's reference family (unrated, on the Doctor Voice Check page)

H05's PASS rule: `c40 >= 0.60 AND (c62 OR c200) >= 0.60`, where:
- **c40** = OPD 4, 19 Sep (primary reference)
- **c200** = OPD 7, 23 Sep (secondary anchor)
- **c62** = OPD 5, 23 Sep (secondary anchor)

The schedule (`~/eta-data/vj/opd-schedule-sep-2026.json`, sha256[:16] `398895d305c9fef9`, 217
slots — verified, matches the order) puts **both** Manoj variants in **Room 7** on the same
weekdays: Dr Manoj (Ortho) 12PM-5PM, Dr Manoj (Physician) 6:30PM-8:30PM. Room 7 is exactly where
c200 comes from, so it is the one anchor genuinely at risk of Manoj-C-evening conflation.

## Finding 1 — c200 (OPD 7, 23 Sep): CLEAR, no conflation

23 Sep 2026 is a Wednesday. Pulled c200's 432 core turns from
`~/eta-data/voice-linkage/dtree84/{link,emb}-rd_u6kdhc3b.json` (`room: "OPD 7 -"`, `date:
"2026-09-23"`) via each turn's `window_id` epoch + `off_s`/`dur_s`:

- **c200 turn span: 12:45:15 – 17:08:17 IST** — entirely inside the Ortho slot (12–5 PM), zero
  overlap with the Physician/evening slot (6:30–8:30 PM).

**c200 is not conflated with Manoj C.** It is squarely in the afternoon Ortho window the schedule
assigns to the target doctor.

## Finding 2 — c62 (OPD 5, 23 Sep): not Manoj-C-evening either, but a DIFFERENT identity risk

c62's turn span (same method, `link/emb-rd_yck5kdc2.json`, `room: "OPD 5"`, `date: "2026-09-23"`,
566 core turns): **14:47:48 – 16:56:22 IST**. There is no Manoj slot of either kind in Room 5 on any
weekday (checked all 30 Room-5 rows in the schedule), so this specific "Manoj C evening" conflation
does not apply to c62 either — but the room-day's real schedule for that exact time raises a
different, more direct problem:

Room 5, Wednesday: 11:30AM–1:30PM Dr Prabhudev Salanki (Uro, walk-in), 1:30–2PM Salanki (TC),
**2:30PM–5PM Dr Vishal Naik (Uro)**. c62's 14:47–16:56 window sits almost entirely inside **Naik's**
slot, not Salanki's (which ends at 2PM) and not anyone named Manoj (who has no Room-5 slot at all).

Checked the one lever available — cosine to the stored Salanki print
(`~/eta-data/vj/centroids/salanki-opd5-c270.json`, ECAPA 192-dim, room_slug
`opd-5-dr-salanki-wxmp` — itself confirming the order's "OPD 5 slug says Salanki" fact):
**cos(c62, Salanki) = 0.13** (well under the 0.60 bar, consistent with c35's own 0.17 vs. Salanki
in the original H05 note) — **c62 is not Salanki**. No stored print exists for Dr Vishal Naik to
check the more likely identity directly (`~/eta-data/vj/centroids/` has only Salanki, Banerjee,
Ankit-TONOR).

**c62's own room-day evidence points away from Manoj and toward Vishal Naik (Uro)**, not toward
either Salanki or a Manoj/Manoj-C conflation. This matches the H05 note's own hedge on c62/c200
("c40's pairing with Manoj had present 2/9"; "c62 and c200 overlap each other by 228 s on 23 Sep")
— c62 was always the weaker of the two secondary anchors, on timing-pair evidence alone, never a
voiceprint match.

## Does this change the H05 verdict?

**No.** The rule is `c40 >= 0.60 AND (c62 OR c200) >= 0.60` — an OR. c200 alone clears 0.60 (0.684)
and is cleanly inside the Ortho slot. **H05's PASS stands on c40+c200 regardless of what c62 turns
out to be.** c62 should not be cited as independent corroborating evidence for Manoj going forward,
and should not enter W51's reference set without its own room-identity resolved (Vishal Naik print
enrolled, or an audio listen).

## ROOM N = ETA OPD N mapping (order's fact 3 — partial verification, more still needed)

Two independent stored-print ties confirm the numeric mapping holds at least at N=3 and N=5:
- `animesh-banerjee-opd3.json`: `room: "OPD 3"` — Room 3 in whatever schedule tab covers Dr
  Banerjee (not in this Sept sheet's rooms 1/4/5/7, so unverified against this specific file, but
  the print's own room field is self-consistently named "OPD 3").
- `salanki-opd5-c270.json`: `room_slug: "opd-5-dr-salanki-wxmp"`, and Room 5's Monday–Saturday
  11:30AM–2PM slot in the Sept schedule is indeed Salanki. **Room 5 = OPD 5 confirmed.**

This is 2 of the order's requested 3-doctor check, both consistent with a plain 1:1 mapping. A third
(ideally Room 4 or Room 7, Kumar S's own two rooms) is still owed before the mapping is used to
score anything — tracked as a PREREG open item, not assumed.

## vj-refuter's independent check (bus #5296, relayed while the bus was down for lx)

vj-refuter re-derived this independently (own read of `link/extension/key-batch2-special.json`,
the linker pairs, and PQM) and reached the **same verdict, VERIFIED**: all three H05 anchors
(c40/c200/c62) pair only to Kumar S; anchor audio spans 12:45-17:08 IST; Manoj C's actual PQM
consults in this window are 18:39-20:20 across 21-23 Sep only (none on 18/19/24 Sep); Manoj C's
uid appears in 0 real linker pairs (only in `-pl-4` placebo/shifted files, which don't count). Their
numbers for c40/c62/c200's own `dominance_rank`-1 pairing (present 2/3, 6/6, 4/4; excess 0.636,
0.529, 0.283) are more precise than the "present 2/9" I only had secondhand from the H05 note's own
prose — worth using their numbers over mine if the two ever conflict.

**New risk they raised, now baked into the prereg (§1 above):** the schedule text names no surname
("Dr Manoj (Ortho)" / "Dr Manoj (Physician)"), and both sit in ROOM 7 on the same weekdays 12 hours
apart — any rule keyed on the name string or on "ROOM 7" without a time bound would mix them. W51's
prereg is uid-and-window keyed for exactly this reason, never name or room alone.

**Their V2 finding (ROOM N = OPD N is UNVERIFIED, with counterexamples)** supersedes this file's
own "2 of 3 confirmations found" framing above — Poornima's actual room on 21/23 Sep contradicted
her schedule row on those exact days, and H05's own booking (OPD 4, 16 Sep) sat in a room the
schedule assigns to someone else that weekday. **The schedule is a prior, never room truth** —
`PREREG-manoj-voice.md` v2 no longer attributes PQM windows to a single assumed room at all; it
tests every room with qualifying audio per window instead. c62 sitting in Vishal Naik's scheduled
Room-5 slot (this file's own earlier finding) turns out to be exactly the kind of case V2 is
warning about, not a rare exception.

## What this does NOT do

No new speaker clustering, no new candidate-identification computation for the actual W51 rule —
see `PREREG-manoj-voice.md`. No centroid written anywhere. No audio moved. No Mini load.
