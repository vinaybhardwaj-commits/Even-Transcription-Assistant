# ETA · Mac Mini task — stand up the Sarvam STT streaming relay

**How to use this doc:** open a **Cowork session on the Mac Mini** and paste this whole file as the first message (or say "Read `ETA-STT-RELAY-MAC-MINI-TASK.md` in this folder and do it"). It is self-contained. Work top to bottom; pause where it says to.

**One-line goal:** run a tiny standalone Node WebSocket relay on the Mac Mini that bridges the Evenscribe browser to Sarvam's streaming STT (the browser can't send the `Api-Subscription-Key` header and Vercel can't hold a socket, so this relay sits in between). Expose it over the existing Cloudflare tunnel at a new hostname `stt.llmvinayminihome.uk`. It is **additive** — it does not touch the diarize service, its launchd job, or its Python venv.

```
browser  --(PCM frames + flush, token-authed)-->  RELAY (this) --(+ Api-Subscription-Key)-->  Sarvam STT WS
browser  <--(codemix transcripts / VAD events)--  RELAY        <--------------------------     Sarvam
```

The app side is already deployed (inert) on evenscribe.app. Once this relay is live and the two Vercel env vars are set (§7), the recording screen switches to real-time streaming automatically.

---

## 0. What you need
- Node 18+ (`node -v`). The Mac Mini already has it (the diarize tunnel host).
- The two files in the `stt-relay/` folder next to this doc: **`stt-relay.mjs`** and **`package.json`**.
- The Sarvam API key (same one in the Evenscribe Vercel env / `_sprint0-secrets`): `<REDACTED>...`.
- A shared secret you invent now (any long random string), call it `STT_RELAY_SECRET`. It must be **identical** here and in Vercel (§7). Generate one: `openssl rand -hex 32`.

## 1. Install
```bash
mkdir -p ~/eta-stt-relay && cd ~/eta-stt-relay
# copy stt-relay.mjs and package.json from the stt-relay/ folder beside this doc into ~/eta-stt-relay/
npm install            # installs ws only
```

## 2. Smoke-test locally (before tunneling)
```bash
cd ~/eta-stt-relay
export SARVAM_API_KEY="<REDACTED>"
export STT_RELAY_SECRET="<REDACTED>"
export PORT=8787
node stt-relay.mjs &
sleep 1
# mint a token + run a 1-frame sanity check (expects an upstream connection, not a transcript):
node -e '
const crypto=require("crypto");
const p=Buffer.from(JSON.stringify({slug:"dr-test",exp:Math.floor(Date.now()/1000)+120})).toString("base64url");
const sig=crypto.createHmac("sha256",process.env.STT_RELAY_SECRET).update(p).digest("base64url");
const ws=new WebSocket(`ws://127.0.0.1:8787/ws?token=${p}.${sig}&mode=codemix&language-code=unknown`);
ws.onopen=()=>{console.log("relay accepted token + opened");setTimeout(()=>{ws.close();process.exit(0)},1500)};
ws.onclose=e=>{console.log("closed",e.code)};
ws.onerror=e=>{console.log("err",e.message)};
'
# expect: "relay accepted token + opened"  (bad/missing token would close with code 1008)
kill %1 2>/dev/null
```
If it prints `relay accepted token + opened`, the relay + auth work. (A full transcript test happens from the Evenscribe sandbox in §8.)

## 3. Run it under launchd (auto-start, survives reboot)
Create `~/Library/LaunchAgents/uk.llmvinayminihome.eta-stt-relay.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>uk.llmvinayminihome.eta-stt-relay</string>
  <key>ProgramArguments</key>
    <array><string>/usr/local/bin/node</string><string>/Users/USERNAME/eta-stt-relay/stt-relay.mjs</string></array>
  <key>WorkingDirectory</key><string>/Users/USERNAME/eta-stt-relay</string>
  <key>EnvironmentVariables</key><dict>
    <key>SARVAM_API_KEY</key><string>PASTE_THE_SARVAM_KEY</string>
    <key>STT_RELAY_SECRET</key><string>PASTE_YOUR_SHARED_SECRET</string>
    <key>PORT</key><string>8787</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/USERNAME/eta-stt-relay/relay.out.log</string>
  <key>StandardErrorPath</key><string>/Users/USERNAME/eta-stt-relay/relay.err.log</string>
</dict></plist>
```
Replace **USERNAME** (run `whoami`) and confirm the node path (`which node` — if not `/usr/local/bin/node`, use the absolute path it prints). Then:
```bash
DOM=gui/$(id -u); LABEL=uk.llmvinayminihome.eta-stt-relay
launchctl bootstrap $DOM ~/Library/LaunchAgents/$LABEL.plist
launchctl kickstart -k $DOM/$LABEL
sleep 2; curl -sv http://127.0.0.1:8787/ 2>&1 | grep -i "Connection\|426\|400" | head -1   # server is up (HTTP upgrade-only port)
tail -5 ~/eta-stt-relay/relay.err.log
```

## 4. Expose over the existing Cloudflare tunnel
Edit `/etc/cloudflared/config.yml` (the same file the diarize service uses — tunnel `llm-tunnel`). Add ONE ingress rule **above** the final `service: http_status:404` catch-all:
```yaml
  - hostname: stt.llmvinayminihome.uk
    service: ws://127.0.0.1:8787
```
(`ws://` — cloudflared upgrades it to wss at the edge.) Then add the DNS route and restart cloudflared:
```bash
cloudflared tunnel route dns llm-tunnel stt.llmvinayminihome.uk   # one-time; ok if it says already exists
sudo launchctl kickstart -k system/com.cloudflare.cloudflared 2>/dev/null || sudo cloudflared service restart
```

## 5. Verify over the tunnel (from the Mac Mini)
```bash
node -e '
const crypto=require("crypto");
const p=Buffer.from(JSON.stringify({slug:"dr-test",exp:Math.floor(Date.now()/1000)+120})).toString("base64url");
const sig=crypto.createHmac("sha256","PASTE_YOUR_SHARED_SECRET").update(p).digest("base64url");
const ws=new WebSocket(`wss://stt.llmvinayminihome.uk/ws?token=${p}.${sig}&mode=codemix&language-code=unknown`);
ws.onopen=()=>{console.log("TUNNEL OK: relay reachable over wss");setTimeout(()=>{ws.close();process.exit(0)},2000)};
ws.onerror=e=>console.log("ERR",e.message);
'
```
Expect `TUNNEL OK`. If it hangs/errors, re-check the ingress rule + cloudflared restart.

## 6. Report back
Tell the Evenscribe thread: "STT relay live at `wss://stt.llmvinayminihome.uk`, shared secret set." Share nothing secret. The sandbox will then run a full Kannada-audio transcript test through the tunnel (§8).

## 7. Vercel env (do this in the Evenscribe project — V, not the Mac Mini)
Set both (Production + Preview), then redeploy:
- `NEXT_PUBLIC_STT_RELAY_URL = wss://stt.llmvinayminihome.uk`
- `STT_RELAY_SECRET = <the same shared secret>`  (mark Sensitive)
The recording screen flips to streaming on the next deploy. Unset `NEXT_PUBLIC_STT_RELAY_URL` to instantly revert to the REST refine trace.

## 8. Final end-to-end (Evenscribe sandbox, after §6)
The sandbox mints a token with the shared secret, streams a real Kannada PCM clip to `wss://stt.llmvinayminihome.uk/ws`, and confirms codemix transcripts return through the relay (target: first phrase ~2.5s, native script + inline English).

## 9. Rollback / hard rules
- The relay is fully isolated: `launchctl bootout gui/$(id -u)/uk.llmvinayminihome.eta-stt-relay` stops it; remove the ingress line + restart cloudflared to unpublish. The diarize service is untouched either way.
- Do NOT modify the diarize launchd job, its venv, or its `/diarize` tunnel rule.
- The relay needs no Python and no GPU — it's a ~90-line pure-Node pipe.
