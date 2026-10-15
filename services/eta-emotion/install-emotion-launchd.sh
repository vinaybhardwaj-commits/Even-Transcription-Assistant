#!/usr/bin/env bash
set -euo pipefail
LABEL="uk.llmvinayminihome.emotion"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
SERVER="$HOME/eta-emotion/app.py"
PYTHON="$HOME/eta-emotion/.venv/bin/python"
HOMEBREW_BIN="$(brew --prefix 2>/dev/null || echo /opt/homebrew)/bin"
LOG_OUT="$HOME/eta-emotion/logs/server.out.log"
LOG_ERR="$HOME/eta-emotion/logs/server.err.log"
UID_NUM="$(id -u)"
mkdir -p "$HOME/eta-emotion/logs"
[ -f "$SERVER" ] || { echo "ERROR: $SERVER missing"; exit 1; }
[ -x "$PYTHON" ] || { echo "ERROR: venv python missing"; exit 1; }
command -v ffmpeg >/dev/null || { echo "ERROR: ffmpeg not on PATH"; exit 1; }
echo "stopping any running instance..."
pkill -9 -f '/eta-emotion/app.py' 2>/dev/null && echo killed || echo "(none)"
# also free port 8086 if a stray uvicorn holds it
if lsof -nP -iTCP:8086 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "WARN: something still on 8086:"; lsof -nP -iTCP:8086 -sTCP:LISTEN || true
fi
launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null && echo "unloaded old" || echo "(none loaded)"
# also try alternate label if present
launchctl bootout "gui/${UID_NUM}/com.vinaybhardwaj.eta-emotion" 2>/dev/null || true
sleep 1
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${PYTHON}</string>
    <string>${SERVER}</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${HOMEBREW_BIN}:/usr/local/bin:/usr/bin:/bin</string>
    <key>EMOTION_PORT</key><string>8086</string>
    <key>EMOTION_HOST</key><string>127.0.0.1</string>
    <key>EMOTION_DEVICE</key><string>auto</string>
    <key>EMOTION_WAVLM_MODEL</key><string>Aniemore/wavlm-emotion-v1-crosslingual</string>
    <key>EMOTION_WAVLM_SUBFOLDER</key><string>auto</string>
    <key>EMOTION_WAVLM_LOAD</key><string>auto</string>
    <key>EMOTION_E2V_MODEL</key><string>emotion2vec/emotion2vec_plus_large</string>
    <key>EMOTION_E2V_HUB</key><string>hf</string>
    <key>EMOTION_E2V_LOAD</key><string>lazy</string>
    <key>EMOTION_E2V_FP16</key><string>0</string>
    <key>EMOTION_E2V_DEVICE</key><string>auto</string>
    <key>EMOTION_MAX_DURATION_S</key><string>60</string>
    <key>PYTHONUNBUFFERED</key><string>1</string>
    <key>HOME</key><string>${HOME}</string>
    <key>HF_HUB_ENABLE_HF_TRANSFER</key><string>0</string>
  </dict>
  <key>WorkingDirectory</key><string>${HOME}/eta-emotion</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${LOG_OUT}</string>
  <key>StandardErrorPath</key><string>${LOG_ERR}</string>
</dict></plist>
PL
echo "wrote $PLIST"
launchctl bootstrap "gui/${UID_NUM}" "$PLIST"
echo "loaded; waiting for model load (up to ~180s)..."
ok=0
for i in $(seq 1 90); do
  sleep 2
  if curl -fsS http://127.0.0.1:8086/health >/dev/null 2>&1; then
    echo "health OK after ~$((i*2))s"
    ok=1
    break
  fi
  # show progress every ~20s
  if [ $((i % 10)) -eq 0 ]; then
    echo "... still waiting (${i}*2s); tail err:"; tail -3 "$LOG_ERR" 2>/dev/null || true
  fi
done
echo "--- health ---"
curl -fsS http://127.0.0.1:8086/health || { echo "HEALTH FAILED"; tail -40 "$LOG_ERR"; exit 1; }
echo
if [ "$ok" != "1" ]; then echo "ERROR: health never became ok"; exit 1; fi
echo "DONE. Inspect: launchctl print gui/${UID_NUM}/${LABEL}"
echo "Restart: launchctl kickstart -k gui/${UID_NUM}/${LABEL}"
