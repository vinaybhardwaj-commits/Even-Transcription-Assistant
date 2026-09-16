# ETA — W2/W3/W4 RULING: request length is the lever, but not the whole lever
**14 September 2026 · Orchestrator · closes the whisper-configuration line**

## 1. Settled

**`max_context` is a no-op on requests under 30 seconds.** Once the slices that vary on repetition were
set aside, the effect was **0 of 5**. It matters only when a request spans several decode windows.

**The mechanism.** A 300-second request is decoded as roughly **ten consecutive 30-second passes, and each
pass can inherit the previous one's loop through the prompt.** A single 30-second request mostly has no
earlier pass to inherit from. That is why slicing a long request and setting `max_context=0` land in the
same range on the same audio.

**So the fix is not in the router.** Route already asks in segments of 1.7–29.8 s — one decode pass each,
nothing to carry. **The fix belongs on the app's long-audio whisper callers**: room-drain, encounter
processing, whisper-chunk, the STT adapter, and the Mini's `stt-drain`. Each should either shorten its
requests or send `max_context=0` where requests must stay long.

## 2. NOT settled — my framing was only partly right

I said route wins because it asks in short questions. **That is about a third of the story.** On W07:

| | repeat ratio |
|---|---|
| whisper, full 300 s request | ~0.37 pooled |
| whisper, sliced into 30 s requests | **0.24–0.32** |
| route | **0.142** (M7) and **0.000** (W1 arm 2) |

Slicing closes part of the gap. **Route goes further, and this test cannot say why.** Three candidates,
unseparated: route cuts on **speech boundaries (VAD)** rather than hard 30-second marks, it applies its
**English guard**, and it has **other engines** to hand the segment to. Hard cuts can also split words at
the edges in a way route's VAD-shaped segments do not.

**The remaining gap — slices 0.24–0.32 against route 0.00–0.14 — is the next question**, and it needs
VAD-shaped segments versus hard splits separated from guard and engine choice.

## 3. ⭐ The noise floor prevented a false positive — keep the method

A raw default-versus-off comparison on short requests showed **6 of 10 slices identical**, which read as
*"`max_context` still does something down here."* Once the slices that vary on repetition were excluded,
the effect was **0 of 5**. **Without W3's noise floor, we would have adopted a setting that does nothing.**

**Standing rule, earned today:** `temperature=0.0` is **not** a promise of repeatable output — whisper.cpp
retries a failed decode at higher temperatures and samples randomly, so the same audio takes different
paths on some windows and stays deterministic on others (6 of 10 identical across three passes). Therefore:
**every future adoption test reports per-window spread and uses more than one pass per setting**, and
**pooled numbers are quoted only alongside that spread** — most of the noise sat in two windows whose
repeat ratio swung 0.000–0.623 and 0.346–0.741, and a single noisy window moves a ten-window pooled ratio
by several points.

## 4. What each measurement is worth now

| | verdict |
|---|---|
| **W2** `max_context=0` on long requests | **REAL** — redundant characters −5,300 (3.2× the noise spread), repeat ratio −0.263 (4.0×). Adopt on long-audio callers. |
| **W1** language `auto` | **NOT above the floor** on whisper alone. Its route-arm "three segments moved" is unjudgeable until **route's own variance** is measured. |
| **W4** request length | **Partly confirms** the hypothesis. `max_context` is a no-op under 30 s; request length is a real lever; it does **not** explain all of route's advantage. |
| **Engine ruling (M7)** | **Unchanged.** Route remains the slow lane's decode. |

## 5. Caveats that travel with all of this
One room, one day. W4 used **one window, two repeats per setting**. "No effect under 30 s" is what was
**observed**, not what whisper.cpp's source guarantees — a 30-second request can still take more than one
decode pass. Route's run-to-run variance has never been measured, so every route-side delta today is
uncalibrated.

## 6. Queued, in order of value
1. **Scope check before any build:** which of the five long-audio whisper callers is on a live path?
   Rooms route to `route` (migrations 0084/0086), so some of those callers may be secondary. **Answer this
   before spending a build round on them.**
2. **Route's own noise floor** — same method as W3. Without it, no route-side delta can be read.
3. **The remaining gap** — VAD-shaped segments versus hard 30 s splits, isolated from the English guard
   and engine choice.
4. **A second room and a second day**, before anything here generalises past OPD-7.
