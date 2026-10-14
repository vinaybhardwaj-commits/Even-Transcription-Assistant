# SURGICAL-CHAIN-LINKER P1: pre-registration v7.10 (linker, 24 Sep 2026): a finished room window with no speech is silence, not a missing transcript

Corrects M1.4 of `P1-PREREG-v7.9.md`; nothing else is edited. **Disclosure: I found this on the first interim yield pass over the 10 items whose windows had all finished (class key sealed; verdicts read by item id only; no class join, no rate).** In that pass 4 of the 10 items came out `INCOMPLETE`, all four for one reason: a shortlisted room whose HIST output is finished (`ok`, state done) and contains **zero turns**. v7.9 M1.4 called "a shortlisted room with no transcript at all (zero turns)" incomplete. That conflated two things: a transcript that is **missing** (no output, or a failed run) and a transcript of **silence** (a finished output with no recognised speech, which the energy shortlist can select on noise).

## N1. The rule, fixed now (before any class is joined)
1. **`INCOMPLETE` means the transcript is missing:** no finished HIST output for a shortlisted room's window (the item is then not staged at all: items are scored only when every shortlisted window has finished), or an empty localized text for the best room (v7.7).
2. **A finished window with zero turns is silence:** no text is sent to Jev; the room's own-prescription score is **0** by definition (nothing in it can be the visit). It is counted and shown beside the item.
3. **A room whose speech is entirely non-English** (no English turn at all) is `LANGUAGE_LIMITED` (share 1.0), as it already is above 0.5 (v7.9 M1.2); it is no longer `INCOMPLETE`.
4. Everything else in v7.5 to v7.9 stands, including the exclusion of the 4 pilot items from accuracy claims.

## N2. What this changes and what it does not
It changes which items are scored (items with a silent shortlisted room are scored instead of withheld) and can only move an item from `INCOMPLETE` to a scored verdict, never the reverse. It is a correction of my own wording, made after seeing that it withholds 4 of 10 items for a reason that says nothing about whether the visit is there; it is disclosed as post-interim, not presented as decided in advance. Whether language-limited items should be scored and flagged instead of withheld is a separate question (their best English-only scores were sometimes high) and is left to Fable and the refuter; no rule changes here.
