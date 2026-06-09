# ETA v2.1 Diarize Service — Phases 7 + 8 Remote Runbook

**Goal:** make the already-built `~/eta-diarize` service survive reboots (launchd) and become reachable at `https://diarize.llmvinayminihome.uk` (Cloudflare tunnel), so Phase 9 (external webm smoke test) can run from off-network.

**Run these on the Mac Mini over your remote shell (SSH / Tailscale / Screen Sharing terminal).** Run blocks in order; stop and report back if any check fails. Copy the output of the **discovery** block to me before editing the tunnel config if you want me to sanity-check it first.

> Source of truth for the service itself: `ETA-DIARIZE-SERVICE-HANDOVER.md`. Token + model cache already in place from setup Phases 0-6.

---

## 0. Pre-flight — confirm the service still runs manually (~1 min)

```bash
cd ~/eta-diarize && source .venv/bin/activate

# make sure nothing is already bound to 8001
lsof -ti:8001 | xargs kill 2>/dev/null; sleep 1

# start in the background
(uvicorn server:app --host 127.0.0.1 --port 8001 --log-level info > ~/eta-diarize/server.log 2>&1 &)

# first start loads models — give it ~30s, then:
sleep 30
curl -sS http://127.0.0.1:8001/health | python3 -m json.tool
# EXPECT: { "ok": true, "device": "mps", "models": ["pyannote-3.1", "ecapa-voxceleb"] }

# confirm the HF token + model cache are present (launchd cold start relies on the cache)
ls -l ~/.huggingface/token && du -sh ~/.cache/huggingface 2>/dev/null
```

If `/health` is not `ok`, stop — tail `~/eta-diarize/server.log` and send it to me. Otherwise, stop the manual instance before installing launchd:

```bash
lsof -ti:8001 | xargs kill 2>/dev/null
```

---

## 1. Phase 7 — launchd auto-start

### 1a. Write the LaunchAgent plist

This uses `$HOME` and `$(whoami)` so you don't have to hand-edit paths. It passes `PYTORCH_ENABLE_MPS_FALLBACK=1` (belt-and-suspenders; server.py also sets it) and an explicit `HOME` so the service finds `~/.huggingface/token` and `~/.cache/huggingface`.

```bash
PLIST=~/Library/LaunchAgents/uk.llmvinayminihome.eta-diarize.plist
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>uk.llmvinayminihome.eta-diarize</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HOME/eta-diarize/.venv/bin/uvicorn</string>
    <string>server:app</string>
    <string>--host</string>
    <string>127.0.0.1</string>
    <string>--port</string>
    <string>8001</string>
    <string>--log-level</string>
    <string>info</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$HOME/eta-diarize</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PYTORCH_ENABLE_MPS_FALLBACK</key>
    <string>1</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/eta-diarize/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/eta-diarize/launchd.err.log</string>
</dict>
</plist>
PLISTEOF

plutil -lint "$PLIST"   # EXPECT: "... OK"
```

### 1b. Load + start it

```bash
PLIST=~/Library/LaunchAgents/uk.llmvinayminihome.eta-diarize.plist
launchctl bootstrap gui/$(id -u) "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
launchctl enable gui/$(id -u)/uk.llmvinayminihome.eta-diarize 2>/dev/null
launchctl kickstart -k gui/$(id -u)/uk.llmvinayminihome.eta-diarize 2>/dev/null

# give models time to load on the managed start
sleep 35
curl -sS http://127.0.0.1:8001/health | python3 -m json.tool
# EXPECT the same healthy JSON as in step 0
```

If health fails here but worked in step 0, check `~/eta-diarize/launchd.err.log` (usually a HOME/cache path issue) and send it to me.

### 1c. Confirm it's registered

```bash
launchctl print gui/$(id -u)/uk.llmvinayminihome.eta-diarize | grep -E "state|pid" | head
```

---

## 2. Phase 8 — Cloudflare tunnel ingress

### 2a. DISCOVERY — find the config + tunnel (send me this output if unsure)

```bash
echo "--- configs ---"
ls -la ~/.cloudflared/ 2>/dev/null
sudo ls -la /etc/cloudflared/ 2>/dev/null
echo "--- active config contents ---"
cat ~/.cloudflared/config.yml 2>/dev/null || sudo cat /etc/cloudflared/config.yml 2>/dev/null
echo "--- tunnels ---"
cloudflared tunnel list
echo "--- how is cloudflared running ---"
sudo launchctl list 2>/dev/null | grep -i cloudflare
ps aux | grep -i "[c]loudflared"
```

Note three things from the output:
- **CONFIG path** — the file that actually has the `ingress:` block with `whisper.llmvinayminihome.uk` in it.
- **TUNNEL name** (or UUID) — the one serving whisper.
- **How it runs** — a system launchd service (`com.cloudflare.cloudflared`) vs. a manual `cloudflared tunnel run` process.

### 2b. Back up + add the diarize ingress rule

Edit the CONFIG file from 2a. The `ingress:` list is order-sensitive — add the new rule **above** the final `- service: http_status:404` catch-all:

```yaml
  - hostname: whisper.llmvinayminihome.uk
    service: http://localhost:8080
  - hostname: diarize.llmvinayminihome.uk      # <-- ADD THIS BLOCK
    service: http://localhost:8001              # <--
  - service: http_status:404                    # catch-all stays LAST
```

Commands (adjust the path to your CONFIG; example shows `~/.cloudflared/config.yml`):

```bash
CFG=~/.cloudflared/config.yml          # <-- set to your actual config path from 2a
cp "$CFG" "$CFG.bak.$(date +%Y%m%d%H%M%S)"
nano "$CFG"                            # insert the diarize block before the 404 catch-all, save
```

### 2c. Route DNS for the new hostname

```bash
cloudflared tunnel route dns <TUNNEL_NAME_OR_UUID> diarize.llmvinayminihome.uk
# if it says the record already exists, that's fine
```

### 2d. Restart cloudflared so it picks up the new ingress

Pick the form that matches 2a:

```bash
# If it runs as a system launchd service:
sudo launchctl kickstart -k system/com.cloudflare.cloudflared
# (if the label differs, use the one from `sudo launchctl list | grep -i cloudflare`)

# OR if you run it manually (tmux/terminal): Ctrl-C the running process, then:
# cloudflared tunnel run <TUNNEL_NAME>
```

### 2e. Verify from the Mac Mini

```bash
sleep 5
curl -sS https://diarize.llmvinayminihome.uk/health | python3 -m json.tool
# EXPECT the healthy JSON, now over HTTPS through the tunnel
```

---

## 3. Hand back to me

Once `https://diarize.llmvinayminihome.uk/health` returns the healthy JSON, tell me — I'll run **Phase 9** from the sandbox: POST a real browser `.webm` to `/diarize` and confirm the full contract holds (this is the first real exercise of the ffmpeg-CLI decode fallback; if it fails the symptom is HTTP 415 and the fix is in `_load_audio()`).

## 4. Rollback (if anything goes wrong)

```bash
# stop + remove the launch agent
launchctl bootout gui/$(id -u)/uk.llmvinayminihome.eta-diarize 2>/dev/null || launchctl unload ~/Library/LaunchAgents/uk.llmvinayminihome.eta-diarize.plist
rm ~/Library/LaunchAgents/uk.llmvinayminihome.eta-diarize.plist

# restore the tunnel config from the backup made in 2b, then restart cloudflared
cp "$CFG.bak.<timestamp>" "$CFG"
sudo launchctl kickstart -k system/com.cloudflare.cloudflared
```

Nothing here touches the whisper or ollama ingress rules, the Vercel app, or any DB — it's purely additive on the Mac Mini.
