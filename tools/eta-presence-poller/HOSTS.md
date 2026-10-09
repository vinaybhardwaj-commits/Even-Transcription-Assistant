# Polled hosts

The real host list (machine names, private addresses, room labels) is local config and is not in this repo.
Copy `hosts.example.json` to `hosts.json` (git-ignored) and list one entry per polled machine: `name` (the machine id the extension reports), `target` (`user@address`), `room`.

Naming: every poller row keys on the full machine hostname, the same string the extension reports as `machine`.
