# LOG — RECORDER (next Room Recorder fleet release)

Build and event log, newest first. Owner to confirm (scribe build + minibot Mini monitor — verify in records). This project was named new on 26 Sep; entries below gather what the records already hold.

## 26 Sep — project named; scope to confirm
Session: roadmap (this pane).
Programme 15 created. Current version stated as 0.1.24 **UNVERIFIED** (scribe's handover records ORB3's Linux recorder at 0.1.22.2, a different build). Queued items gathered from records: self-test hooks (r368/369), auto-start at clinic open if V approves (item 151), mute/silence/unplug detection, device-missing handling.
Refs: brief; HANDOVER-scribe.md.

## 25 Sep — recorder backlog facts (from scribe)
Session: scribe.
ORB3 Linux recorder 0.1.22.2 stopped delivering 25 Sep 15:49, recovered 26 Sep 09:52 on its own. Swift app backlog: tape_advancing must follow tape.pcm growth not tape.idx; poll must report device_lost; same-uid set_audio_input is a NO-OP; DEVICE_MISSING may not fire for a lost device.
Refs: HANDOVER-scribe.md §(b)6, §(b)8.

## 23 Sep — ehrc-audiometry room recorder added to the pool
Session: (Mini night-lab ruling).
ehrc-audiometry (M4, 16 GB) runs the EvenScribe Room Recorder app in a live room — never touch its recorder app/tape/audio/login items.
Refs: orders/RULING-MINI-NIGHT-LAB.md.

## Release process (to confirm)
R3 self-update proven 10 Sep (**UNVERIFIED exact date**). Gates + rollout plan still to be written once scope + owner are confirmed.
