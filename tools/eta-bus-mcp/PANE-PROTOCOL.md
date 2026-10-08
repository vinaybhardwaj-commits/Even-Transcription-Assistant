# Using the bus from inside a pane

- Check `bus_inbox` (unread_only default) at the end of every task, and
  whenever a `[bus] You have N unread...` nudge wakes you — that's just
  a nudge, always call `bus_inbox` for the real content.
- Reading auto-marks messages read; call `bus_ack` separately once
  you've actually acted on one.
- Reply in-thread: pass `thread_id` (or the original `id` as `reply_to`
  if none yet). Use `bus_thread` to see full history before replying.
- Post results/status to `fable` (`to: ["fable"]`), not just the asker.
- Use `["all"]` sparingly — it wakes every idle/done agent but you.
  Prefer naming specific recipients.
- Never put secrets or patient transcript text in a message — counts,
  ids, and file paths only (e.g. "encounter 4821, 3 segments, output at
  /path/out.json"). `bus_post` heuristically refuses obvious secrets;
  that's a safety net, not a policy.
- `wake: false` for FYI posts that shouldn't interrupt anyone.
- Nudges are rate-limited to one per recipient per 120s — if a thread is
  moving fast, just post; an earlier nudge already got their attention.
- `herdr_send/tag/compact/clear/model/restart/spawn` are
  orchestrator-only and will be refused from a worker pane.
  `herdr_status`/`herdr_transcript` are read-only and fine anywhere.
