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
2026-10-06 21:45-22:00 IST | router-fix | R-C-LEX v4 deploy: swap router_server.py + eta_number_words.py in ~/eta-router, restart com.vinaybhardwaj.eta-router (no Whisper bulk work) | none | booked
2026-10-06 21:46-21:46 IST | router-fix | R-C-LEX v4 deploy | none | done (router_server a876b3bd63acfd1b, eta_number_words ae6f83e4f96a6b13, lexicon 2849f61aee1d75dd; rollback = bak-rclex-20261006-214507)
2026-10-07 21:45-22:00 IST | router-fix | W-OBS v1 deploy: swap router_server.py (a876b3bd -> 76eedf2e), restart com.vinaybhardwaj.eta-router (no Whisper bulk work) | none | booked
2026-10-07 21:46-21:46 IST | router-fix | W-OBS v1 deploy | none | done (router_server 76eedf2e1c9698c7, eta_number_words ae6f83e4f96a6b13 untouched; rollback = bak-wobs-20261007-214506)
