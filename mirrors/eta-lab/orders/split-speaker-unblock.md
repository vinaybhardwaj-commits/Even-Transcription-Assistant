# UNBLOCK — you do not need fleet. Cut now. — 20 Sep 08:00

Stop waiting. Kill your 60s watcher. The route you are polling is not needed for this.

## My error
I sent fleet to build a presign route for bench-window clips. An operator tool that already does
exactly that has been available the whole time: **`scribe_extract_audio`** on the Scribe MCP. I
did not check before commissioning a production slice. That cost you and V about an hour of
waiting, and it is mine, not yours.

## It works — I verified it just now, on your own first window
Call, using the manifest's `session_id` and the window's clock time in IST:

    scribe_extract_audio(session_id="bs_j7n3vj84", start="17:45:00", end="18:00:00")

Returned `ok:true`, `joined:true`, a **presigned GET URL with a 3600 s expiry**, content_type
`audio/webm`, `duration_ms` 900008 against your window's 900 000 — the right 15 minutes, joined
across 4 chunks, `source_used: "primary"`.

## How to convert your manifest to the call
`start_ms` / `end_ms` are epoch ms. IST = UTC + 5:30.
Worked example from your own manifest, which is how I got the numbers above:
`1789820100000` → 12:15:00 UTC → **17:45:00 IST**; `1789821000000` → **18:00:00 IST**.

All 22 clips come from **one session, `bs_j7n3vj84`, 10 windows** — so 10 calls, not 22, exactly
as your own plan said. Then slice each window's `segs` out of the downloaded audio as you
already designed.

## Two constraints the tool imposes, both satisfied
- It refuses a window over 30 minutes. Yours are 15.
- It refuses **while any room is recording**. Nothing is recording — verified, clinic is closed,
  Sunday morning.

If a call comes back `no_audio_in_range`, that is a real gap: drop the clip, count it, do not
substitute. Same rule as before.

## Everything else in your design stands
Concatenate the label's segs in time order with the 400 ms audible seam. Cap ~25 s, though your
max `clip_s` is 18.0 so it never triggers. No normalisation, filtering or resampling. Counts and
alignment offsets only on stdout, including in error paths — the presigned URL contains an R2 key
and a signature, so **never print it, never log it, never write it to a file**. Treat it exactly
as you would a credential.

## Then
Cut the 22, run `selftest.py`, confirm all 22 exist, and come back with the link. V has been
waiting since before 07:00.
