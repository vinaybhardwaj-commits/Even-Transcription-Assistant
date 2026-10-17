#!/usr/bin/env bash
set -euo pipefail
LABEL="com.vinaybhardwaj.eta-indic"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
SERVER="$HOME/eta-indic/indic_server.py"
PYTHON="$HOME/eta-indic/.venv/bin/python"
HOMEBREW_BIN="$(brew --prefix 2>/dev/null || echo /opt/homebrew)/bin"
LOG="$HOME/eta-indic/server.log"
UID_NUM="$(id -u)"
[ -f "$SERVER" ] || { echo "ERROR: $SERVER missing"; exit 1; }
[ -x "$PYTHON" ] || { echo "ERROR: venv python missing"; exit 1; }
command -v ffmpeg >/dev/null || { echo "ERROR: ffmpeg not on PATH"; exit 1; }
echo "stopping any running instance..."
pkill -9 -f indic_server.py 2>/dev/null && echo killed || echo "(none)"
launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null && echo "unloaded old" || echo "(none loaded)"
sleep 1
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"\>
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${PYTHON}</string><string>${SERVER}</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${HOMEBREW_BIN}:/usr/local/bin:/usr/bin:/bin</string>
    <key>INDIC_PORT</key><string>8082</string>
    <key>INDIC_DECODING</key><string>rnnt</string>
    <key>HF_HUB_OFFLINE</key><string>1</string>
    <key>PYTHONUNBUFFERED</key><string>1</string>
    <key>HOME</key><string>${HOME}</string>
  </dict>
  <key>WorkingDirectory</key><string>${HOME}/eta-indic</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict></plist>
PL
echo "wrote $PLIST"
launchctl bootstrap "gui/${UID_NUM}" "$PLIST"
echo "loaded; waiting for model load (up to ~60s)..."
for i in $(seq 1 30); do sleep 2; curl -fsS http://localhost:8082/healthz >/dev/null 2>&1 && { echo "healthz OK after ~$((i*2))s"; break; }; done
echo "--- healthz ---"; curl -fsS http://localhost:8082/healthz\; echo
echo "--- inference test (hi) ---"
curl -sS -X POST http://localhost:8082/inference \
  -F "file=@$HOME/Library/Mobile Documents/com~apple~CloudDocs/Even Documents/LLM Brain/Locally running LLM/asr-bench/scan/enc_bzker67cb5.wav;type=audio/wav" \
  -F "language=hi" -F "decoding=rnnt" -w "\nHTTP %{http_code} in %{time_total}s\n"
echo "--- recent log ---"; tail -6 "$LOG"
echo "DONE. Inspect with: launchctl print gui/${UID_NUM}/${LABEL}"
