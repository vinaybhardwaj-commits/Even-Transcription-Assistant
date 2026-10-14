# lab sshd (herdr-kit, Fable ruling 129, 24 Sep 2026)

**Why.** The Mini's system sshd is launchd inetd-style with `Instances => 42` (SIP-protected `/System/Library/LaunchDaemons/ssh.plist`).
Every box pane holds two stdio-over-ssh MCP sessions to the Mini (`ssh mini-bus` for the bus, `ssh mini .../even-jev-mcp/run.sh`).
At the cap launchd accepts a connection and closes it: `kex_exchange_identification: Connection closed by remote host`.

**What.** A user-mode sshd on `127.0.0.1:2223` (no sudo, no cap), a second reverse forward box `2224` -> Mini `2223`, and the box
ssh config pointing `mini` / `mini-bus` at 2224. The system sshd and the 2222 reverse forward are untouched; old sessions drain as panes restart.

| Piece | Where |
|---|---|
| sshd config (reference copy, `$HOME` for the home dir) | `sshd_config.reference` -> `~/.ssh/lab-sshd/sshd_config` |
| host key (private, NEVER in git) | `~/.ssh/lab-sshd/ssh_host_ed25519_key` |
| lab sshd LaunchAgent | `com.eta-lab.lab-sshd.plist` -> `~/Library/LaunchAgents/` |
| reverse forward LaunchAgent (`BOXHOST` = `eta@<box ip>`, substituted at install) | `com.eta-lab.bus-tunnel-lab.plist` |
| box `~/.ssh/config` | `Host mini`, `Host mini-bus` Port 2224; `mini-legacy`, `mini-bus-legacy` Port 2222 (backup `config.bak-labsshd-24sep`) |
| box `~/.ssh/known_hosts` | `[127.0.0.1]:2224` = the lab host key (SHA256 fingerprint checked with `ssh-keyscan -p 2224 127.0.0.1`) |
| check | `verify-lab-sshd.sh` (50 concurrent from the box x3, instance counts, probe tail) |
| watch | `../ssh-mini-probe.sh` -> `bus/ssh-mini-probe.log` |

**Deviation from the ruling.** `MaxStartups` is `100:30:200`, not `30:30:100`: with 30:30:100, 8 of 50 simultaneous connections were dropped
(`drop connection ... Maxstartups` in the lab log) because they were all unauthenticated at once. At 100:30:200, 50/50 succeeded three times, 0 drops.

**Install (Mini).** `mkdir -m 700 ~/.ssh/lab-sshd`; `ssh-keygen -t ed25519 -N "" -f ~/.ssh/lab-sshd/ssh_host_ed25519_key`; copy the reference config
(replace `$HOME`); `/usr/sbin/sshd -t -f ~/.ssh/lab-sshd/sshd_config`; copy both plists to `~/Library/LaunchAgents/` (substitute `BOXHOST`);
`launchctl bootstrap gui/501 <plist>` for the sshd first, then the tunnel. Add the lab host key to the box's known_hosts as `[127.0.0.1]:2224`.

**Reload without dropping sessions.** After panes use it, change the config and `kill -HUP $(cat ~/.ssh/lab-sshd/sshd.pid)`. Do NOT `launchctl kickstart -k` it then: that kills every session on it.

**Rollback.** `launchctl bootout gui/501/com.eta-lab.bus-tunnel-lab` and `.../com.eta-lab.lab-sshd`; on the box restore `~/.ssh/config` from
`config.bak-labsshd-24sep` (or swap the Ports back). New sessions then use 2222 again. The 2222 job is never modified by any of this.

**Drain.** The system sshd stays at its cap (42) until old panes restart; each restart moves that pane's two sessions to the lab sshd.
The count only falls below 42 when panes restart, or when someone else's sessions end.
