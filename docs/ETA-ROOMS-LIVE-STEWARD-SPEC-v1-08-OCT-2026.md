# Rooms Live: Steward reporting, v1 (FLEET product spec, 8 Oct 2026 18:55 IST)

Owner: FLEET (fable), Rooms Live product owner. Builder: GATING (the Steward and the Rooms Live code are GATING's).
V's ruling, 8 Oct 18:53: "The steward should report to this page" (evenscribe.app/rooms-live).

## Why
Tonight OPD 4 lost its webcam mic twice (14:23 and 17:16 IST). The Steward saw both events, decided correctly to
message, alert and hold restarts, and logged all of it to steward_decisions. Nothing reached anyone, because every
action except scribe_start is in shadow and the page shows none of it. Staff and V learned of the fault only from the card.

## Measured facts (fable, Neon read-only, 13:20Z)
- steward_config: kill_switch {"on":false}; shadow {"global":false}, with every action shadowed except
  scribe_start:false. last_tick 13:19:30Z, 9 rooms, degraded [], elapsed about 1.9 s.
- 48 h: 2443 shadow rows and 10 live rows, all scribe_start, all this morning between 02:00 and 04:42Z.
  OPD 1 and OPD 4 were "failed: no ack" at 02:00Z.
- OPD 4 between 12:40 and 12:58Z alternates `session_died/message` and `ok/none` every 2-5 min. That is FLAPPING.
- Rules seen: ok, session_died, doctor_away, silent_no_consult, device_missing, device_missing_hold, mic_fault,
  mic_check_pending, kiosk_asleep, not_recording.
- Actions seen: none, log_only, message, alert, scribe_start, scribe_restart, ticket:wake.

## Build (no migration; read steward_decisions and steward_config server-side, inside the existing Rooms Live auth)
S1. Steward status strip under the page header, one line:
    "Steward: checked 1 min ago · starts recording: ON · restarts and alerts: watching only".
    Build it from last_tick.at and the shadow map. It turns amber if last_tick is more than 3 min old and red if more than 10 min.
    Show "Steward off" when kill_switch.on is true.
S2. One Steward line on each room card, under the status text. It uses the newest decision in the last 60 min whose
    action is not none or log_only. When there is none, it shows the newest hold rule (device_missing_hold) or nothing.
    Plain words, with the live/shadow difference explicit:
      live:   "Steward started recording at 07:30" / "Steward restarted recording at 18:10" / "Steward asked the kiosk to wake at 07:05"
      shadow: "Steward would have restarted recording at 18:10 (watching only, not done)"
      hold:   "Steward is holding restarts: the mic is missing"
      failed: "Steward tried to start recording at 07:30, the kiosk did not answer"
    Keep the wording in one mapping table (rule + action + mode + result to sentence). No raw rule names on the page.
S3. Live Steward actions and Steward alerts (live or shadow) go into the "Changes today" list, tagged "Steward".
S4. The card's existing "Details" view gets the room's last 20 non-ok decisions (time, sentence, mode, result).
S5. Flapping fix in the Steward, before any message or alert goes live: session_died must hold for 2 consecutive ticks
    (or 3 min) before it fires. One session_died episode produces at most one message until the room is ok for 10 min.
    Add a test that replays OPD 4 12:40-12:58Z and expects one episode, not four.
S6. Do NOT flip any shadow flag in this build. Turning on alerts or messages is a separate decision, made after S5 ships.

## Must not
No PHI on the page beyond what it already shows (doctor name, room). No new table. No migration. No change to the
Steward's decisions except S5. No hard deletes.

## Verify
Unit: the mapping table covers every (rule, action, mode, result-prefix) seen in the last 48 h. A test fails if an
unmapped combination renders a raw name. S5 replay test. The page renders with steward_config unreadable: the strip
says "Steward status unavailable" and the cards still render. Refuter PASS before deploy (GATING's loop), then tell fable.

## Report
Reply on the bus to fable: commit, deployment id, test counts, and one screenshot path of /rooms-live showing the strip and the OPD 4 card line.

## ADDENDUM A1 (V ruling, 8 Oct 19:55 IST): a Steward log link on every card
S7. Put a small "Steward log" link in the top-right corner of every room card, under the status chip. Do not
    displace the chip, and keep it secondary in weight. It opens /rooms-live/steward/<room_slug>, a full page in the
    same auth, mobile-friendly:
    - header: room name, kiosk machine, and the S1 status line;
    - date picker: today by default, back 30 days (the retention window);
    - toggle: "Things it did or wanted to do" (default; hides ok/none/log_only rows) versus "Everything";
    - newest first, one row per decision: time (IST), the S2 sentence, a Live or Watching-only tag, the result
      ("done", "kiosk didn't answer", "skipped"), and the why text in plain words;
    - consecutive identical ok rows collapsed into "All fine 07:30-12:40 (63 checks)";
    - paging at 200 rows.
S8. A page-level "All Steward logs" link next to "updated N s ago" opens the same view across all rooms, with a
    room filter.
Same rules apply: no migration, read steward_decisions only, no raw rule names, no PHI. S4 (last 20 in Details) stays
as the quick view. S7 is the full history. Verify: the link exists on every card in every section (Needs attention,
Fine, No doctor signed in). The page renders for a room with zero decisions today ("No Steward activity today").
