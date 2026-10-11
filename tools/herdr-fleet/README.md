# herdr-fleet

Read-only fleet board for the herdr agent fleet, plus the R2 fleet JSON publisher.

- `fleetboard.py` — builds the board from herdr state, `roster.json`, `jobs.json`, `leads.json`.
- `publish_fleet.sh` — publishes the fleet JSON to R2 (`sarvam_callers.json` lists callers it checks).
- `hx` — runs herdr on a fleet machine over multiplexed ssh.
- `check_palimpsest_hourly.py`, `run.sh`, `progress.sh`, `smoke_test.py` — helpers and checks.

The live copy runs from the Mac Mini (`/Users/vinaybhardwaj/dev/_fable/herdr/fleetboard`);
this tree is the versioned record of it. Edit here, then sync to the Mini.

Hosts and probes are set locally, never committed:
- `hx asus|yoga` read `HX_HOST_ASUS` / `HX_HOST_YOGA` (`user@host`) and fail if unset.
- `fleetboard.py` uses `HX_HOST_ASUS` for the asus fast-ssh path when set.
- `roster.json` `ssh_probe` values are `"<set locally>"`; fill them in on the Mini.
