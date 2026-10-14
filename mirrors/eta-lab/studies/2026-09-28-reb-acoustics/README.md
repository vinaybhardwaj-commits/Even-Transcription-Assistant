# A-REB acoustics layer (engine room_profile_acoustics v1, cfg hash 690f05d4)

DSP-only REB acoustics tracks for 15-minute windows (level, noise floor, SNR, clipping, exact-zero spans).
Written via kit/reb writer + validator. Convention: `r2_key` = first chunk key, `audio.duration_ms` = nominal window length.

- `acoustics_layer.py` engine, `transport_dryrun.py` writer (scratch root by default, `--live` for the live root), `spot_check.py` recompute check.
- `transport_dryrun.py` applies `heldout.is_held_out` (R3/W51) to every window, fail closed: import/load failure crashes, tz-naive times raise, blind windows are skipped before any audio is read.

## 26 Sep OPD4 quarantine (Fable #8160, #8315 item 7)
Eight acoustics tracks on the blind room-day 26 Sep OPD4 (room_ux92qpws, windows 0900-1045) were moved with `mv` into
`<window>/tracks/_quarantine-r3w51/` (recorded in R3W51-EXPOSURE-LEDGER Addendum P). REB is append-only, so the window
`manifest.json` files and the day `index.jsonl` were NOT edited and still reference the old paths. That is intentional:
readers must expect those 8 acoustics tracks to be missing from `tracks/`. The STT tracks on windows 1015/1030 stay in place
(covered by QUARANTINED-R3W51).
