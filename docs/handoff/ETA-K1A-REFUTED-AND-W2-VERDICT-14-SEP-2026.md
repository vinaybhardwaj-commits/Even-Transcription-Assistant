# ETA — K1a is REFUTED, and W2 is a clear win
**14 September 2026 · Orchestrator · two rulings**

## 1. K1a — the kiosk stop WORKS. My framing was wrong.

I recorded the defect as *"a stopped kiosk keeps recording."* The falsifiable test says otherwise.

**No window with a grid start at or after 13:15 exists for either room.** Checked at 13:50:43, by which
time the 13:15, 13:30 and 13:45 slots were all due and all absent. Both rooms' 13:00 windows are **still
open, never closed** — because the piece that would have completed them never arrived. **Capture stopped
mid-slot**, which is exactly what a working stop looks like.

The timing is tighter still: OPD 7's last window was created **12 s before** `cmd_nhqfwqj2` was
acknowledged; OPD 4's **15 s after** `cmd_tvrv8mq4`, which fits one in-flight piece flushing on stop.

**So `end_day` to a listening kiosk does stop it, and the command path is sound.**

### The real question has moved
Why did the ends on **11 and 13 September** not stop capture? The likeliest reading is that **those ends
never reached the device as a command at all.** Two candidates, both unverified:
- a **server-side end** — a reaper, or `close_orphaned_session`, which the tool's own description warns is
  *"a SERVER-SIDE REPAIR, not a stop: no command is queued and no kiosk is involved"*;
- a stop sent while the kiosk was **not listening**.

If it was `close_orphaned_session`, this is not a kiosk bug at all — it is a repair tool doing exactly what
it says, used where a stop was intended, leaving the row closed and the device running. **That would make
the fix documentation and a guard rail, not code.**

**K1b is untouched and still real:** the server accepted chunks for `ended` sessions right up to 13:06
today. That remains the containment.

**What settles it:** `bench_chunk` timestamps for 11–14 Sep, and the kiosk's own stop path.

⭐ **Three method notes worth keeping.** *Wait long enough before concluding* — checking 35 minutes after
the stop meant three slots were due and absent, so "no windows" is evidence rather than a gap in the
schedule. *An open window is also a signal* — the created-but-never-closed 13:00 rows pin the stop to that
slot more precisely than zero rows could. *Separate what a result proves from what it rules out* — a
working `end_day` today proves the command path works **when the kiosk is listening**; it does not explain
the 11/13 September ends, so the record stays open rather than closed.

## 2. W2 — `max_context=0` is a win, and it passed the trap

| | before | after |
|---|---|---|
| redundant characters | 6,987 | **1,687** |
| M4 collapse fraction | 0.404 | **0.143** |
| windows containing a loop | 7 | 6 |
| realtime factor | 0.0237 | 0.0209 |

**The trap check is the important line.** Raw characters fell by 3,135 — which on its own could mean we had
simply lost text. But the text remaining **after** removing repeats **rose**: **+2,165 characters under
rule A, +2,226 under M4's collapse.** Repeated text fell further than total text did. **We did not lose
speech; we gained it.** That is the distinction the headline ratio alone cannot make, and it is why the
character count was required beside it.

**Why the per-request field was the right lever:** the experiment was confined to ten requests, the plist
was untouched, whisper-server stayed the same process, **every production caller kept its behaviour
throughout**, and there is nothing to restore.

⭐ **Why the help text was not enough:** there are **two context knobs at different scopes**. `no_context`
clears context *between requests* and the server already sets it true. `max_context` governs carry-over
*between the 30-second decode windows within one request*. The help line explains neither, so it could
have been read either way. **Read the scope, not the name.**

### Not adopted yet, and here is the reason
- **The effect is not uniform.** W01–W03 barely moved. **W06–W08 still loop at 0.24–0.33**, and their
  rule-B run counts *rose*. **Context explains most of the redundant text, not all of the looping.**
  There is a second mechanism still unidentified — the Builder's unverified candidate is whisper.cpp's VAD
  joining speech islands into one buffer before decoding.
- One room, one day, **one run per setting**. Repeatability is unverified.
- Nothing is draining, so there is no cost to waiting and no benefit to rushing it into the router.

**Ruled:** W2's result is accepted as measurement. **Adoption into the router's `whisper_infer` waits for
W1 and a confirmation run on a second room's audio.** Then both settings go in together, measured, once.

## 3. Next
**W1 — whisper's forced English**, per `ETA-W1-WHISPER-LANGUAGE-CC-KICKOFF-14-SEP-2026.md`, with the same
per-request discipline W2 just proved: change the request, not the plist; leave every other caller alone.
Then the second-room confirmation, then adopt.
