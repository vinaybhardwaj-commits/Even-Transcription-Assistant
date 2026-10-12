# ORB3 clock sync, room locator and ORB3Sat (lab, 9-10 Oct 2026)

- orb3-sync/: acoustic beacon clock sync v3 (beacon_gen, beacon_rec.sh, beacon_sync, tests). Refuter R10 CONFIRMED.
- orb3-loc/: 2D TDOA room locator (locate.py, walk_sync.py, walk_track.py, walk_rec.sh) and synthetic tests L1-L8. Refuter R14/R15. geom.json is the Tech-room mic geometry.
- orb3sat/: the Raspberry Pi satellite. follower.py records while ORB3 captures. sender.py (v3) ships 5-min pieces to ORB3 over a write-only rrsync key. systemd units, test mocks, and the one-off install scripts the operator ran.
- orb2-cutter/o15/cutter_v2.py: case cutter v2.2 (recorder session spans, weak-activity fallback onset, t0_flag).

Account names are placeholders: `sat` is the Pi user, `lab` the ORB3 user. No audio, tape, case ids or addresses are included.
