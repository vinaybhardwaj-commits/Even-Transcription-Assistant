#!/usr/bin/env bash
# Copy the index-mirror units into ~/.config/systemd/user and NOTHING else: no daemon-reload, no enable, no start. consult-lead does those after review:
#   systemctl --user daemon-reload; systemctl --user enable --now index-mirror.timer
# The OnFailure drop-in (systemd/index-mirror.service.d-onfailure.conf) is a separate file, installed by hand like the cutter's.
set -euo pipefail
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; mkdir -p "$HOME/.config/systemd/user"
cp "$D/index-mirror.service" "$D/index-mirror.timer" "$HOME/.config/systemd/user/"
echo "installed (not loaded, not enabled, not started): $HOME/.config/systemd/user/index-mirror.{service,timer}"
