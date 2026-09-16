# Operator MCP — tool notes

The long-form notes that used to live inside tool descriptions. Tier 2 §2.4 cut those to ≤ 150
words each: a description is read by a model on every `tools/list`, so it pays for itself only if
it carries the contract. The reasoning belongs here.

## The surface: 28 listed tools, 52 names that answer (Slice E, 13 Sep; E18 R31, 16 Sep)

`tools/list` publishes **27** tools. `tools/call` accepts those 27 **and every one of the 52 names**
the door has published — the 51 at `6b2347e` plus `scribe_window_speakers`, added by Slice C2
(`0f27b8c`) — for as long as the door exists. A regroup, not a rename.

**What a group is.** Ten of the 27 are groups. A group picks ONE of the original tools by an
argument and runs **that tool's own handler** with the caller's context, so behaviour, refusals,
scope checks and response shape are the original tool's — there is no second implementation.

**A group's description is at most 150 words, and nearly all of it is generated.** The only prose is
one or two sentences of framing. Every value, the tool it runs and (for `scribe_room_command`) where
it executes are generated from the same variant table that routes the call, so a variant added or
renamed cannot leave the description behind; `lib/mcp/surface.ts` refuses at load to build a group
over the cap, and routes every variant's probe at load so the list cannot claim a routing the code
does not do. The members' own long descriptions are **not** copied in — a fresh client does not see
them for grouped tools. They stay in `lib/mcp/tools/*`, each argument's own description still rides
in the schema, and a client with an old cached list still shows them. An argument whose description
starts with `[view=…]` (or `[kind=…]`, `[no id]`, etc.) applies only to the variants named there. An
unknown or missing selector answers `{ ok:false, error:"unknown_<key>", allowed }` and runs nothing.

**One scope per group.** The door checks a token's scopes against the tool it was called by name.
`lib/mcp/surface.ts` refuses at load to build a group whose members differ in scope, so a group can
never let a read token reach a write variant. Read and write therefore never share a group. That no
group mixes a tool that can quote identity or audio with one that cannot was ruled per group in
review; the code does not check it.

| Listed tool | Scope | Selector → the published tool that runs |
|---|---|---|
| `scribe_health` | read | `aspect`: `all` (default) → `scribe_health`; `stt` → `scribe_stt_health`; `voice` → `scribe_voice_health`; `llm` → `scribe_llm_health`; `kb` → `scribe_kb_probe` |
| `scribe_system` | read | `view`: `map` → `scribe_system_map`; `stores` → `scribe_store_stats`; `stt_engines` → `scribe_list_stt_engines`; `stt_routing` → `scribe_stt_routing`; `stt_tripwires` → `scribe_route_tripwires` |
| `scribe_rooms` | read | `view`: `list` → `scribe_list_rooms`; `now` → `scribe_diff_room`; `fleet` → `scribe_fleet`; `day_report` → `scribe_day_report`; `clusters` → `scribe_get_clusters` |
| `scribe_sessions` | read | `view`: `list` → `scribe_list_sessions`; `replay` → `scribe_replay_session` |
| `scribe_session_tape` | read | `view`: `session` → `scribe_get_session`; `manifest` / `timeline` / `chunk` / `zip` → `scribe_get_recording` with that `mode` |
| `scribe_encounter` | read | exactly one id: `encounter_id` → `scribe_get_encounter`; `trace_id` → `scribe_get_trace`; both or neither → `one_id_required` |
| `scribe_stt_runs` | read | `subject_id` or `encounter_id` given → `scribe_get_stt_run`; neither → `scribe_list_stt_runs` |
| `scribe_voice` | read | `view`: `prints` → `scribe_list_voiceprints`; `samples` → `scribe_list_voice_samples`; `window_speakers` → `scribe_window_speakers` |
| `scribe_room_command` | write | `kind`: `start_day` → `scribe_start_recording`; `pause_day` → `scribe_pause_recording`; `resume_day` → `scribe_resume_recording`; `end_day` → `scribe_stop_recording`; `close_orphaned_session` → `scribe_close_orphaned_session`; `set_audio_input` → `scribe_set_audio_input`; `check_update_now` / `report_diag` / `restart_engine` → `scribe_room_command` |
| `scribe_scratch` | write | `action`: `replay` → `scribe_replay_write`; `fuse` → `scribe_fuse_run` |

`scribe_silence_readjudicate` (write, E18 R31, 16 Sep) is listed on its own: it takes no selector, and no
group absorbs it because a group holds one scope and the silent backlog is the only thing it acts on. The plain
call is a DRY RUN that writes nothing and reports what it would re-adjudicate — how many windows, over what span,
across how many rooms, and what evidence those verdicts hold. `apply: true` does the work and requires `detector`
and `reason`; an unscoped apply also requires `all_rooms: true`. Nothing schedules it.

The other 17 are listed exactly as before: `scribe_get_state`, `scribe_list_cues`, `scribe_post_cue`,
`scribe_pin_visit`, `scribe_mark_consult`, `scribe_extract_audio`, `scribe_transcribe_range`,
`scribe_list_encounters`, `scribe_list_traces`, `scribe_set_visit_clinician`, `scribe_fuse_report`,
`scribe_list_commands`, and the `jobs.ts` tools `scribe_job_submit`, `scribe_job_status`,
`scribe_job_list`, `scribe_job_cancel`, `scribe_audit_recent` — by ruling, 13 Sep, no group absorbs a
`jobs.ts` tool. That ruling is why the surface is 27 and not the 25 first proposed.

**Where each `scribe_room_command` kind executes.** `start_day`, `pause_day`, `resume_day`,
`end_day` are queued as a `bench_command` for the room's listening kiosk. `set_audio_input` (app
0.1.21+), `check_update_now`, `report_diag`, `restart_engine` (0.1.22+) are queued for the native
Room Recorder; a browser kiosk ignores them. `close_orphaned_session` is a **server-side repair, not
a stop**: nothing is queued and no kiosk is involved.

**Two names are both an old tool and a group: `scribe_health` and `scribe_room_command`.** Called
the old way — `scribe_health` with no `aspect`, `scribe_room_command` with one of its three native
kinds — each is the tool it always was, with the same arguments. The schema a fresh client sees is
wider than the one a cached client holds; both describe the same tool. The new description opens
`SAME TOOL, MORE ASPECTS.` / `SAME TOOL, MORE KINDS.` with the old call shape, and the generated list
that follows names every value and the tool it runs.

**Audit.** A group call's `audit_log` row has `target_id` = the group and
`metadata_json.variant` = the published tool that ran. A call by an old name writes exactly the row
it wrote before.

**Proof the old names hold.** Two `tools/list` answers captured from the live door with curl:
`fixtures/mcp/live-tools-list-6b2347e.json` (51 names — the floor, never edited) and
`fixtures/mcp/live-tools-list-0f27b8c.json` (52 names, after C2). `tests/unit/mcp-surface-aliases.test.ts`
enumerates THOSE files — never the registry, which would shrink with the code — requires the later
capture to contain every name of the floor, and for every name checks behaviour, not wording:

- it resolves, with the same scope, to the very object its tool file exports (the two reused names
  resolve to their group);
- a call through the door carrying every argument the schema declared runs that object's own handler
  with exactly those arguments, and the caller gets back exactly what the handler returned;
- a token without the tool's scope gets `-32001` and nothing runs;
- against **each** capture that published it, no declared argument is removed, retyped, narrowed to
  fewer enum values, or newly required — unless the change is listed in the test's
  `ACCEPTED_CONTRACT_CHANGES`, which names the decision and is itself tested to still be real.

**One accepted contract change.** `scribe_job_submit.kind` and `scribe_job_list.kind` no longer
offer `diarize_clip` (Slice C2 decision D3: it is gone, not renamed; `diarize_window` implements it
for real). At `6b2347e` it was a stub that accepted a job and then failed `not_implemented`; a caller
now gets `unknown_kind` at submit. Ruled acceptable on 13 Sep — fail at the boundary, never accept
what cannot be honoured — and the stub is not to be restored.

**Descriptions are not frozen** — they are meant to change as tools change. A recaptured fixture may
add names; it must never drop one of the 51.

## `detail: "summary" | "full"`

`summary` is the default on `scribe_diff_room`, `scribe_day_report`, `scribe_system_map`,
`scribe_fuse_report` and `scribe_fleet` (and so on `scribe_rooms` `now` / `fleet` / `day_report`
and `scribe_system` `map`). It is a **narrower selection of the same facts** — nothing
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

**After Slice E a stale client still works.** It lists the old tools (51, or 52 if cached after C2), and every one
of those names still answers. What it cannot see is the new group names until it reconnects. Verify the surface
with curl against the door, never by asking a connector what it lists.
