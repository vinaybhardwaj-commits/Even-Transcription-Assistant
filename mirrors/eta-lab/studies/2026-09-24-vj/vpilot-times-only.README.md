# V-pilot clips, times only (Fable ruling 197(c); split-speaker, 24 Sep)

`vpilot-times-only.json`: 189 clips from pilot pages v2 (25), v3 (65), v4 (48), v5 (51). One row per clip:
`clip_id` (opaque, unique within a page), `page`, `repeat_of` (the clip_id this hidden repeat repeats, else null),
`window_id`, `window_source`, `session_id`, `start_ms`/`end_ms` (absolute epoch ms of the clip), `turn_full_ms`
(v2/v3 only: the clip is the first part of a longer turn; its full length), `segs` (v5 only: [start_ms,end_ms] pairs of the
segments the clip is made of; start_ms/end_ms are the span that covers them), `share_of_clip_inside_window`.

**Blinding.** Times and ids only. There are NO answers, no doctor named on the clip, no room, and no manifest key fields
(`true_doctor`, `present_as`, `named`). Those stay on the Mini with the answers (pilot dirs
`/Users/vinaybhardwaj/dev/scratch/split-speaker-pilot-v2..v5/{answers.jsonl,manifest.json}`), for whoever loads truth into
/srv/vj-truth. What each answer means is in split-speaker's #660: v2/v3 = "is this the one named doctor" (me / not him),
v4/v5 = "yes that's Dr <named>" / "no, someone else"; a clip's doctor comes from the manifest, so the truth loader needs it.

**How windows were assigned.** v5's manifest carries `wid` for 48 of its 51 clips; for the other 3, and for every v2-v4 clip
(the manifests have session_id and times but no window id), `window_id` is the bench_window of that session whose span
contains the clip start. Check on the 48 v5 clips that have both: the derived window equals the manifest's in 48 of 48.
No clip is missing a window (189/189) and none straddles a window end. 37 windows, 7 sessions.

**For the >= 50 % time-overlap join.** Use `start_ms`/`end_ms` (v2-v4) and `segs` (v5, several segments per clip). For v3 the
LABEL applies to the clip, which is the first `dur` ms of a longer turn: `turn_full_ms` says how much longer, so a turn that
overlaps the clip by 50 % of the TURN may overlap it by less than 50 % of the CLIP. Decide the denominator on purpose.
Hidden repeats (v2: 3, v3: 5) are the same audio asked twice; their answers are the same clip's, so use `repeat_of` to
dedupe or to measure V's self-consistency, not to count twice.
