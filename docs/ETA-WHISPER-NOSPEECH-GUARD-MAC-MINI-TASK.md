# ETA · Whisper no-speech / anti-hallucination guard — Mac Mini runbook

> ✅ **APPLIED + VERIFIED — 30 May 2026.** V applied this on the Mac Mini. `whisper-server` now launches under launchd (`uk.llmvinayminihome.whisper`) with `--vad --vad-model models/for-tests-silero-v6.2.0-ggml.bin --no-speech-thold 0.7 --suppress-nst`. Independently confirmed from the sandbox: `whisper.llmvinayminihome.uk/healthz` → `{"ok":true}`, and a 3 s silence clip → `{"text":""}` (was `" Thank you."`). **B14 is now closed both app-side and source-side.** Topology note: public URL → tunnel → `whisper-shim.py` (8081, ffmpeg→WAV transcoder) → `whisper-server` (8080). See `ETA-MAC-MINI-BACKEND-HANDOVER.md` §13. The steps below are retained for reference / re-tuning (raise `--no-speech-thold` toward 0.8 to be more aggressive).

**Context:** B14 (see `ETA-BUG-LOG.md`). ASR engines hallucinate confident fluent text on **non-speech / silence / ambient noise** — memorised ad jingles, "thanks for watching", etc. The app-side submit guard (shipped `b14-transcript-guard-shipped`) strips the *lead-in* after the fact. This runbook closes the gap **at the source** for the local Whisper engine so silence/noise produces *empty* output instead of fabricated text.

**Scope:** the `whisper.cpp` server on the Mac Mini (the one behind `WHISPER_BASE_URL = https://whisper.llmvinayminihome.uk`, `POST /inference`, model `ggml-large-v3-turbo`). Whisper feeds the **live rolling testbed** and the **English-encounter note fallback** (longer-of-two, B6). The Sarvam multilingual path is unaffected by this change.

**Why you (V) must run it:** the Cowork sandbox can reach the public HTTPS URL but **not** the home LAN, and this changes how the launchd service launches the binary. Paste-ready below. ~10 min.

> ⚠️ Do **not** `pip`/`brew upgrade` anything. This only changes launch *flags* + (optionally) downloads a VAD model. The diarize venv pin is untouched.

---

## Step 0 — locate the service (don't assume)

```bash
# Find the whisper launchd job + its plist
launchctl list | grep -i whisper
ls -l ~/Library/LaunchAgents | grep -i whisper
sudo ls -l /Library/LaunchDaemons 2>/dev/null | grep -i whisper
```

Note the **label** (e.g. `uk.llmvinayminihome.whisper`) and the **plist path**. Then read how it launches the binary:

```bash
PLIST=~/Library/LaunchAgents/<the-whisper-plist>.plist   # adjust path
/usr/libexec/PlistBuddy -c "Print :ProgramArguments" "$PLIST"
```

You'll see something like `… /path/to/whisper.cpp/build/bin/server -m …/ggml-large-v3-turbo.bin -t N --host 127.0.0.1 --port 8xxx …`. Note the **server binary path** and **port**.

## Step 1 — confirm which flags this build supports

```bash
SERVER=/path/to/whisper.cpp/build/bin/server   # from Step 0
"$SERVER" --help 2>&1 | grep -iE "speech|vad|suppress|entropy|logprob|fallback|context"
```

Whisper.cpp flag names drift between versions. Match what you see to the list below — **use only flags that appear in `--help`.**

| Goal | Likely flag (confirm in --help) |
|---|---|
| Skip non-speech regions (best lever) | `--vad` + `--vad-model <ggml-silero-vad.bin>` (newer builds) |
| Treat low-speech segments as silence | `--no-speech-thold 0.6` (raise toward 0.8 = more aggressive) |
| Suppress non-speech tokens | `--suppress-nst` (older: `--suppress-non-speech-tokens`) |
| Stop run-on hallucination loops | `--no-context` (don't condition on previous text) |
| Entropy / logprob fallback gates | `--entropy-thold 2.4`, `--logprob-thold -1.0` |

### (Recommended) download the Silero VAD model if `--vad` is supported

```bash
cd /path/to/whisper.cpp
# models/download-vad-model.sh exists in recent whisper.cpp; else fetch ggml-silero-vad.bin
bash ./models/download-vad-model.sh silero-v5.1.2 2>/dev/null || \
  echo "No download script — grab ggml-silero-vad.bin from the whisper.cpp models release and place in ./models/"
ls -l models/*silero*vad* 2>/dev/null
```

## Step 2 — back up the plist, then add the flags

```bash
cp "$PLIST" "$PLIST.bak.$(date +%s)"
```

Add the supported flags to `ProgramArguments`. Conservative recommended set (drop any your build lacks):

```bash
# VAD (preferred) — adjust the model path to where you placed it
/usr/libexec/PlistBuddy -c "Add :ProgramArguments: string '--vad'" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments: string '--vad-model'" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments: string '/path/to/whisper.cpp/models/ggml-silero-vad.bin'" "$PLIST"
# No-speech + non-speech-token suppression (defense in depth)
/usr/libexec/PlistBuddy -c "Add :ProgramArguments: string '--no-speech-thold'" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments: string '0.7'" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments: string '--suppress-nst'" "$PLIST"

# sanity: re-print to confirm
/usr/libexec/PlistBuddy -c "Print :ProgramArguments" "$PLIST"
```

(If you'd rather edit the plist in a text editor, just append the same `<string>` entries inside `<array>` under `ProgramArguments` — one `<string>` per token, flag and value on separate lines.)

## Step 3 — reload the service

```bash
LABEL=uk.llmvinayminihome.whisper   # from Step 0
launchctl unload "$PLIST" && launchctl load "$PLIST"
launchctl list | grep -i whisper   # should show a fresh PID, exit code 0
```

## Step 4 — verify (this is the important bit)

**A. Health / a real clip still works:**
```bash
curl -s https://whisper.llmvinayminihome.uk/inference -F file=@/path/to/a/real/short.wav -F response_format=json | head -c 400
```
Should return normal text.

**B. Silence/noise now returns EMPTY (the actual fix):**
```bash
# make 5s of silence
ffmpeg -f lavfi -i anullsrc=r=16000:cl=mono -t 5 -y /tmp/silence.wav 2>/dev/null
curl -s https://whisper.llmvinayminihome.uk/inference -F file=@/tmp/silence.wav -F response_format=json
```
**Before:** often a hallucinated phrase ("thank you", "thanks for watching", etc.).
**After:** empty / whitespace `text`. ✅ That's the guard working.

## Rollback

```bash
cp "$PLIST.bak.<timestamp>" "$PLIST"
launchctl unload "$PLIST" && launchctl load "$PLIST"
```

---

**After you've run it:** tell me the silence-clip result (empty vs hallucinated) and I'll note B14 as fully closed (app-side + source-side). If `--vad` isn't in your build, the `--no-speech-thold`/`--suppress-nst` pair still helps; upgrading whisper.cpp for VAD is optional and can wait (don't do it mid-pilot).
