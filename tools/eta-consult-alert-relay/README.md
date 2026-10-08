# eta-consult-alert-relay
Relays alert lines from the cutter's local alert spool to the ETA bus over ssh. Dry-run by default; `--live` posts.
Config: copy `config.example.json` to `~/.config/consult-alert-relay/config.json` and `ssh-config.example` into your ssh config (local values; not in this repo). Unit: `systemd/consult-alert-relay.service`.
Tests: `python3 -m unittest discover -s tests`
Snapshot of a private repo (no history). Real hosts, addresses and key paths are local config.
