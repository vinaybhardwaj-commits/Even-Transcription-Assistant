# orders/queue 001-herdr-kit — Refuter verdict (eta-refuter-2, 23 Sep 2026)

Under review (herdr-kit, 803ce0a · 321cc71 · f61fb19 · 9adc601 · 6be07ab): kit/clip-fetch.{sh,py},
clip_fetch_core.py, clip_fetch_mcp.py · kit/neon-connection-uri.mjs · kit/hsend.sh · kit/pane-watch.py ·
training/diar-lab/lib_diar_train.py + nightly_export.py · studies/2026-09-24-e7-fullday/e7-rescore.sh.
Not built by this session. No audio was downloaded. The coverage audit is metadata only (read-scope
manifest). The trim test used synthetic audio.

**VERDICT: FAIL on clip-fetch (K1): the audio it builds is time-shifted against the window it claims to be,
and every downstream label is scored against that shifted timeline.** The other items pass with small fixes.
Anything already exported through this path (VAD-v3's 45 windows on gcp-l4 + orbox3, diar-lab's 2 training
windows) must be re-fetched after the fix before any result built on it is used.

## K1 (HIGH, reproduced): `-ss` before `-i` with `-c copy` starts early, by up to a seek interval
`trim()` (clip_fetch_core.py:71–76) puts `-ss offset` BEFORE `-i` and stream-copies. On webm/opus, ffmpeg can
then only start at a seek point at or before the offset. The cut starts EARLY, and everything in it
arrives LATE relative to the window.
- Synthetic proof (silence to t=100.000 s, then a tone; libopus webm; ffmpeg 4.4): the script's exact
  `-ss 97.5 -i … -t 10 -c copy` put the tone onset at **5.007 s instead of 2.500 s**, and the output was
  **12.5 s long, not 10**, i.e. a 2.5 s shift. The fix, output seeking with a decode
  (`-i … -ss 97.5 -t 10 out.wav`), gave onsets **2.507 s / 4.707 s** where 2.5 s / 4.7 s were expected
  (7 ms codec lookahead), and exactly 10.000 s.
- herdr-kit's own live check fits this: "903 s duration (a 900 s window, ±3 s from webm keyframe
  boundaries)". Those 3 s are not noise. They are audio from BEFORE the window start (and at each chunk
  seam), so every teacher label (pyannote.ai intervals, RTTM) sits up to seconds off its audio.
- Consequences: VAD-v3 scoring (my method review asks for a ±0.25 s collar; a 1–3 s shift swamps it), and
  diar-lab segmentation fine-tuning trained on misaligned RTTM.
- Fix: decode each chunk to PCM with output-side seeking (`-i src -ss off -t dur`, wav/flac), concatenate PCM,
  and encode last. Then ASSERT the output duration is within 0.1 s of the window length. Anything else is
  an error, never a result.

## K2 (MEDIUM, measured): chunk gaps are closed silently, so later audio shifts early
`fetch_window_clip` concatenates whatever chunks overlap the window. It never checks that they cover it,
and never pads a gap. A metadata-only audit of the 45 VAD-v3 windows (read-scope `scribe_get_recording`
manifests, no audio; 44 answered, 1 timed out) found:
- **4–5 chunks per window**. Every seam is a K1 trim, so the early starts **accumulate** along the
  window. That is how you get 903 s from 900.
- **2 of 44 windows have an internal gap of 5.62 s and 5.82 s** (covered 894.2–894.4 s of 900). The
  concatenated file closes the gap, so everything after it sits ~5.7 s EARLY against the window's clock.
  Whether pyannote.ai's own clip closed the same gap is UNVERIFIED. The only safe answer is to pad the gap
  with silence (keeping wall-clock alignment) and then assert duration = window length.
- No leading gaps and no chunk overlaps. `ended_at − started_at` equals `duration_ms` on every chunk, so
  the manifest clock is internally consistent. It is not an independent check of the audio.

## Other items
- **neon-connection-uri.mjs + e7-rescore.sh: PASS-WITH-FIXES.** r.ok is checked (good), and the URI goes
  only to stdout. (a) `secret_env` swallows its stderr (`2>/dev/null`). If Neon's API fails,
  APP_DATABASE_URL is `""` and the child starts anyway. Make the replay/rooms stages refuse on an empty
  URI. (b) `env VAR="$(…)" cmd` places the URI in `/usr/bin/env`'s **argv** for the instant before it
  execs, which the header's "never argv" rules out. This is pre-existing for the other secrets and the
  window is tiny; use `export` in a subshell instead. (c) It is the owner role plus a project-admin API key,
  same as my neon-select N2. For a lab replay that writes shadow runs, a scoped role is the right end state.
- **hsend.sh: PASS-WITH-FIXES.** The log path is `$(dirname $0)/..`, and `~/dev/eta-lab/hsend.sh` at
  the repo root is a SYMLINK to kit/hsend.sh. Invoked by that form, the log goes to
  **`~/dev/scratch/hsend.log`**, outside the repo, and `mkdir -p` creates `~/dev/scratch` (evaluated under
  zsh for `./hsend.sh` and for the absolute root path). Fix: `${0:A:h}` (zsh resolves symlinks). PATH
  change: fine.
- **pane-watch.py inline order: PASS, one thing UNVERIFIED.** The size cap and the fallback are right. Not
  shown: that a MULTI-LINE `herdr agent prompt` arrives as ONE prompt. If herdr types it and a newline
  submits, the order is split and its first line runs alone. Prove it once, by sending a 3-line prompt to
  a scratch agent and reading it back.
- **lib_diar_train / nightly_export:** the wiring is correct, but it inherits K1 and K2. The 2-window training
  manifest (datasets/diar-train-2026-09-23-7b5e5f9f.json) was built on shifted audio.
- **clip-fetch lower:** window_id is interpolated into SQL (clip_fetch_core.py:46) and run through the
  owner-role neon-select, so validate it with `^[A-Za-z0-9_-]+$`. `tempfile.mktemp` puts **patient audio in
  /tmp**, with the default umask (world-readable), and `raw_path` leaks on a failed download or trim (it's
  removed only after a successful trim). Use a `TemporaryDirectory(dir=<workdir>)` with mode 0700.
  A presigned URL is never logged, and the read-scope-only design is right.
