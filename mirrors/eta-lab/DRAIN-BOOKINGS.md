# Mini Whisper drain bookings

Rule (agreed 23 Sep 2026): ONE bulk drainer on the Mini's Whisper at a time. Live rooms always come first.
- 07:30-21:30 IST: no bulk drains on the Mini Whisper.
- 21:30-07:30 IST: eta-night-drain owns the Mini Whisper unless a slot is booked below.
- Every bulk job holds `lockf -k /tmp/eta-whisper-drain.lock` for its whole run. If the lock is held, wait. Never kill another drainer.
- Cancel only through the audited MCP job-cancel tool.
- Book a slot by adding one line BEFORE starting. Add a done line AFTER.

Format: `YYYY-MM-DD HH:MM-HH:MM IST | owner | job | windows | status`

2026-09-23 21:30-07:30 IST | Fable | eta-night-drain + overnight-translate | nightly | booked
2026-09-23 | Fable | both eta-night-drain (night-drain.mjs) and overnight-translate (overnight-translate.mjs) now take `lockf -k -t 0 /tmp/eta-whisper-drain.lock`, non-blocking, held for the whole run, wait+log-once+retry on contention, never kill | confirmed by held-lock dry test | done
2026-09-23 12:45-21:30 IST | Fable | DAY EXCEPTION (V): live room STT off (ROOM_AUTO_DRAIN_ENABLED=off); Mini Whisper free for Fable-scheduled work; still one bulk job at a time via the lock | - | active
