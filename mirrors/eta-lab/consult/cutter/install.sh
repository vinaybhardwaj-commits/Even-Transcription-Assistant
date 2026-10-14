#!/usr/bin/env bash
# Install the units into ~/.config/systemd/user but leave the timer DISABLED and stopped (consult-lead enables it after review: systemctl --user daemon-reload; systemctl --user enable --now cutter-hourly.timer).
set -euo pipefail
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; mkdir -p "$HOME/.config/systemd/user"
cp "$D/cutter-hourly.service" "$D/cutter-hourly.timer" "$HOME/.config/systemd/user/"
echo "installed (disabled, not started): $HOME/.config/systemd/user/cutter-hourly.{service,timer}; run 'systemctl --user daemon-reload' to load them"
