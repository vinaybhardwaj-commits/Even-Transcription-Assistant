# Who Is Speaking (rating page, ruling 165 B)

Raters hear one turn with 3 s of audio either side (the turn is marked on the audio bar), read the guarded
transcript line, and say who is speaking: doctor / patient / companion or relative / staff / cannot tell, plus an
optional note. Phone-first. `page.html` is one file; Fable publishes it.

## Seed contract (vj-data emits it; nothing else)
db collection `turns`, one doc per turn, **doc id = the id**:

    {"id": "k7Qe2x", "audio": "audio/k7Qe2x.mp3", "duration_s": 10.0,
     "turn_start_s": 3.0, "turn_end_s": 5.5, "text": "<guarded transcript line>"}

- `id`: opaque (letters, digits, `_`, `-`), no window, room, doctor or stratum in it.
- `audio`: MP3 32 kbps mono, served as a page file at exactly this relative path. Clip = 3 s before + the turn + 3 s
  after (less at a window edge). `turn_start_s` / `turn_end_s` are seconds **inside the clip**.
- `text`: the guarded transcript line of the turn (shown raw; raters are PHI-cleared).
- **No other field.** No machine label, production role, `speaker_basis`, margin, doubtful/confident flag, doctor,
  room, window id. The page keeps only the six fields above, but anything else in the doc is readable in the db by
  anyone with devtools, so `check_seed.py` treats extra fields as an error. Keep the key (id -> everything else) in
  `~/vj/` off the page.
- Turns under 0.8 s are excluded (ruling 165). 150 items: 110 doubtful + 40 confident, in one seed, no groups visible.

Check before writing to the db:

    python3 check_seed.py <seed_dir> --expect 150      # seed_dir/turns/*.json + seed_dir/audio/*

## Capabilities and db rules (for the publish)
`db` and `user` (`user` with scopes `["profile"]` so the Results tab can show names).

    db rules: { path: "turns",  read: "view",     write: "admin" }
              { path: "labels", read: "interact", write: "interact" }

Answers: `labels/<rater id>` = `{rater, schema:1, t:{<turnId>:{a, note?, ts}}}`, `a` is one of
`doctor | patient | companion | staff | cannot_tell`. The page shows items in a fixed hashed order of the id (the same
for every rater), so an id that encodes a group leaks nothing, and shows only "Turn n of 150".
Note: with `labels` readable by every interacting user, a rater could read the other's labels through devtools.

## Owner tab "Results"
Uses the scoring rule from the ruling: a turn is scored when at least one rater answered something other than
"cannot tell" and the real answers agree; if raters who gave real answers disagree, the turn is excluded and counted.
Export for the scorer is Fable's job (labels/* from the db to `~/vj/truth/`).

## Audio
Each clip is fetched into a Blob URL ahead of time (current + next two), so playback needs no byte-range support
from the host (iOS Safari does) and starts inside the tap. If the fetch fails the file is played directly.

## Test
    ./browser-check.sh [out_dir]     # Chromium, 375 px + 1280 px, light + dark; needs ~/.cache/eta-browser-check
    python3 make-harness.py out.html # stand-alone test page with invented turns and a test tone
The mock turns carry hidden fields on purpose to prove the page never shows them.
