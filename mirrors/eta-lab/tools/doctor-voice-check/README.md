# Doctor Voice Check (ruling 183, VOICE-LINKAGE.md)

V agrees or disagrees with proposed doctor-voice links. `page.html` is one file; Fable publishes it. Phone-first.
Built from the speaker-count / who-is-speaking pattern.

## Two card types
- **Link card**: room, date, proposed doctor; the evidence in plain words; three 4-8 s clips of that voice from
  different consults plus one clip of someone else in the room, marked as the contrast; **Agree / Disagree / Not sure**;
  on Disagree, **Who is it?** (the doctor list or Unknown); optional note.
- **Same person? card**: two clips (Clip A, Clip B) from the same doctor on different days or rooms. Buttons:
  Same person (= agree) / Different people (= disagree). No "Not sure" on pairs (per the spec); leave a card open to skip.

A card counts as answered when: agree or not sure; or disagree AND who is chosen; or (pair) same / different.

## Card contract (vj-link emits it; nothing else)
db collection `links`, one doc per card, **doc id = the id**:

    link: {"id":"k4Qm9z","kind":"link","room":"Room 4","date":"2026-09-21","doctor":"Dr X",
           "evidence":["PQM: 9 of 11 consults line up, within 40 s.", "..."],
           "clips":[{"src":"audio/k4Qm9z_0.mp3","duration_s":5.2}, x3], "contrast":{"src":"audio/k4Qm9z_3.mp3","duration_s":5.0}}
    pair: {"id":"r5Dn3x","kind":"pair","a":{"src":"audio/r5Dn3x_0.mp3","duration_s":4.1},"b":{"src":"audio/r5Dn3x_1.mp3","duration_s":4.0}}

- Optional `"batch": <integer>` (default 0): batches show in order (first batch 60 cards, then rolling batches of 40),
  scrambled only within a batch, so a rater never finds a new card among ones already answered.
- **No other field**: no confidence tier (HIGH/MED/LOW), PQM score, cluster id, the true doctor. The page keeps only
  the fields above, but anything else in a doc is readable in the db and the tier would bias the rating (V's
  agreement rate on the HIGH sample decides auto-accept). Keep tier and key in `studies/2026-09-24-voice-jev/link/`
  or `~/vj/`, off the page. Ids are opaque and unrelated to the tier.
- Clips are MP3 32 kbps mono served as page files at exactly the `src` path (small; the page fetches each card's
  clips into Blob URLs ahead of time, so no byte-range support is needed and it plays on iPhone).
- Optional doc `config/doctors` = `{"names":["Dr A", ...]}` for the "Who is it?" list (else the proposed doctors
  on the link cards).

Check before writing to the db:

    python3 check_cards.py <dir> --expect 40      # dir/links/*.json + dir/audio/*

## Capabilities and db rules (for the publish)
`db` and `user` (`user` with scopes `["profile"]`).

    { path: "links",    read: "view",     write: "admin" }
    { path: "config",   read: "view",     write: "admin" }
    { path: "verdicts", read: "interact", write: "interact" }

Verdicts: `verdicts/<rater id>` = `{rater, schema:1, v:{<cardId>:{a:"agree|disagree|unsure", who?:"<name>|unknown", note?, ts}}}`.
Cards appear in one fixed hashed order of the id for every rater. Owner tab **Results**: counts per card type and
each rater's verdict per card; the tier-based HIGH auto-accept rule is computed offline from these verdicts plus vj-link's key.

## Test
    ./browser-check.sh [out_dir]     # Chromium, 375 px + 1280 px, light + dark
    python3 make-harness.py out.html # stand-alone page with invented cards and test tones
The mock cards carry a tier and other hidden fields on purpose to prove the page never shows them.
