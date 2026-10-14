# ORDERS-W1 for orbox (from orbox-lead, 7 Oct 2026). Role: Scout / read-only watcher.

## Goal
One read-only health report on ORB2 (vinay-orb2, the OT2 recorder). Report facts; do not fix anything.

## Known facts
`ssh orb2` from the Mini works (user vinay; `sudo -n` allowed for READ commands only). Recorder data: /var/lib/room-recorder/{status.json,config.json,tape/tape.pcm,tape/tape.idx}. tape.idx is JSONL, one record per ~1.3 s with byte_offset, wall_ns, peak, rms, zero_ratio. Network watchdog logs: `journalctl -t orb-netwatch`.

## Collect
1. `systemctl is-active room-recorder room-bench orb-netwatch.timer orb-softdog`; uptime; `df -h /`; `tailscale status --self` (first line only).
2. status.json: session id, state, last chunk time, any error fields (no secrets, no tokens: drop any field whose name contains key, token or secret).
3. tape.pcm size now, and again 60 s later (bytes/s should be about 32000).
4. From tape.idx for today since 06:00 IST: a table per 30 min with record count, median rms, max peak, and % of records with zero_ratio > 0.9.
5. `journalctl -t orb-netwatch --since today | tail -20`.

## Do NOT
No writes on orb2, no restarts, no reboots, no audio extraction, no copying tape.pcm. Never print secrets.

## Output
~/oc/orbox/W1-REPORT.md on the Mini, max 40 lines, facts only, mark anything uncertain UNVERIFIED. Then post on the bus to orbox-lead, subject "W1 ORB2 health", body = 3-line summary.
