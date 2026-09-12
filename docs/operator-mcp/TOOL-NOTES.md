# Operator MCP — tool notes

The long-form notes that used to live inside tool descriptions. Tier 2 §2.4 cut those to ≤ 150
words each: a description is read by a model on every `tools/list`, so it pays for itself only if
it carries the contract. The reasoning belongs here.

## `detail: "summary" | "full"`

`summary` is the default on `scribe_diff_room`, `scribe_day_report`, `scribe_system_map`,
`scribe_fuse_report` and `scribe_fleet`. It is a **narrower selection of the same facts** — nothing
is computed differently, nothing is rounded, nothing new appears under `full`. `full` is exactly
the payload these tools returned before Tier 2, so a caller that parsed them keeps working by
asking for it by name.

`degraded` rides **both**. A section of a read that failed must never be hidden by a narrower view:
an operator told a room is fine when the brain read failed is worse off than one told nothing.

## `scribe_diff_room` — what `full` adds

`summary` keeps: `room`, `page_open`, `listener_state`, `recording`, `recording_session_id`,
`room_state` (with `flags` and `drift_since`), `tape_lane`, the three pause fields, `last_piece_at`,
`last_cue`, `stalled_age_ms`, `flags`, `degraded`.

`full` adds the lane lines (`lanes.transcript`, `lanes.visits`) and their counts, `audio_recorded_ms`,
`stranded_audio`, `mic_level` / `mic_size` / `spare_*`, `has_room_day_today`, the warehouse
doctor-clock fields (`warehouse_silent_ms`, `has_doctor_clock`, `doctor_clock_note`),
`marks_today` / `marks_not_sent`, `last_window_asked_at` / `last_window_complete`, and
`ended_disagrees` with its session ids.

**`warehouse_silent_ms` measures one labelled doctor's Pulse clocks and nothing else.**
`even_hospitals.doctor_opd_rooms` is null on every hospital, so the warehouse holds no room. A gap
means that doctor has not clocked — never that the room is empty, and never that Pulse is quiet:
another doctor may be in the room seeing patients throughout. It is null unless a session is
recording, the room is not paused, and a genuine warehouse-typed cue exists on the room-day. There
is no fallback to the session's own start: with no cue the answer is null, because the number that
fallback produced was the length of the recording wearing a clock gap's label, and it turned every
room amber at fifteen minutes and red at thirty.

**`stranded_audio`** is minutes that cannot currently be turned into words, split into waiting for
someone to run it / no day record / never closed, measured in fifteen-minute slots. That is **not**
the measure `audio_recorded_ms` uses (which sums the pieces themselves), so the two do not subtract.

**`room_state.flags` is NULL, never `[]`**, where no Mac is bound to the room, where the install has
not been evaluated since migration 0081, or where the read failed. An empty list means the Mac was
looked at and is well. These are coarse alarms over uncalibrated thresholds (per-room noise floors
are R2.5): a flag means go and look, never a diagnosis.

## Per-token scopes (§2.3)

`SCRIBE_MCP_TOKENS` is a JSON object keyed by the **SHA-256 hex of the token**, so the env var never
holds a usable credential:

```json
{ "<sha256 hex>": { "actor": "operator-v", "scopes": ["read", "invoke", "write"] } }
```

Resolved before `SCRIBE_MCP_TOKEN`, which still works and still grants all three scopes as actor
`operator-v1` — nothing that works today stops working. A token whose entry lists only `read` gets
`-32001 scope_or_tool_unavailable` on every invoke/write tool. An entry with an unreadable or empty
`scopes` list gets **nothing**: a malformed list must never widen access.

`audit_log.actor_id` carries the resolved actor as `mcp:<actor>`.

## Downstream budgets (§2.5)

Every outbound call from a tool runs under an explicit budget **strictly below** the tool's own
(read 55 s, invoke 115 s), and blowing it returns a named envelope rather than a shape-only degrade:

```json
{ "error": "whisper_timeout", "elapsed_ms": 40021, "budget_ms": 40000 }
```

The gap between the downstream budget and the tool budget is deliberate headroom, so the tool still
has time to shape and return that error instead of being killed mid-sentence by its own deadline.
An empty list and a null field are indistinguishable from "there is nothing there"; a named timeout
tells an operator which box to go and look at. Anything that legitimately needs longer is a **job**
(Slice B), not a longer timeout.

## `listChanged`, and why your client may still be stale (§2.6)

`initialize` advertises `capabilities.tools.listChanged: true`. The tool set is built at module load
from the registry, so a deploy changes it and a client that honours the notification picks the new
set up.

**A client that caches its manifest regardless still needs reconnecting.** On 12 Sep the Claude
connector served a tool list fetched before `scribe_room_command` existed: the server answered
`tools/list` with 44 tools including it, `cache-control: no-store`, `x-vercel-cache: MISS` on every
door (production, cache-busted, path-key, branch alias) — nothing was cached on the server side at
all. Tool *calls* were proxied live and returned the new fields, while the *descriptions* were
months stale. Fresh results with stale descriptions is the signature: reconnect the integration.
