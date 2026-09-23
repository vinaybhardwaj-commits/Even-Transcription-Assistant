# Applying `/speech_regions` to the Mini's eta-diarize

`speech_regions_block.py` is APPENDED, byte-exact, to `~/eta-diarize/server.py` on the Mac Mini. That
file is in no git repository; this copy exists so the change can be reviewed and fetched exactly.

It is additive: every line already in `server.py` (`/diarize`, `/enroll`, `/embed_speakers`) must be
byte-identical afterwards, and nothing in the new block runs at import — Silero is loaded lazily on the
first request, inside try/except, so a missing Silero cannot stop the service from starting.

## Apply (on the Mini) — do NOT restart without Fable's say-so

```bash
cd ~/eta-diarize
cp server.py server.py.bak-20260923-prevad
N=$(wc -l < server.py.bak-20260923-prevad)
git -C ~/dev/Even-Transcription-Assistant fetch -q origin
git -C ~/dev/Even-Transcription-Assistant show origin/vinay/diarize-vad-trim:scripts/eta-diarize/speech_regions_block.py >> server.py
python3 -c "import ast; ast.parse(open('server.py').read()); print('parses')"
diff <(sed -n "1,${N}p" server.py.bak-20260923-prevad) <(sed -n "1,${N}p" server.py) && echo "existing ${N} lines BYTE-IDENTICAL"
```

## Is Silero available to this venv? (decides whether the endpoint can work at all)

```bash
~/eta-diarize/.venv/bin/python -c "import silero_vad; print('silero_vad pip: OK')" \
  || ls -d ~/.cache/torch/hub/snakers4_silero-vad_master 2>/dev/null \
  || echo "NO SILERO: the endpoint will answer ok:false and Vercel will send the whole clip"
```

If neither is present the endpoint is still safe — every call answers `vad_model_unavailable` and the
Vercel side falls back to the pre-trim behaviour. Trimming simply does not happen until Silero is there.

## Offline test of the pure shaper (no model, no restart)

```bash
python3 ~/dev/Even-Transcription-Assistant/scripts/eta-diarize/test_shape_regions.py \
  ~/eta-diarize/server.py /tmp/shaped_map.json
```

## Smoke after a restart (a 3 s tone; Silero will likely call it non-speech, which is a valid answer)

```bash
python3 -c "import wave,struct,math;w=wave.open('/tmp/eta-vad-smoke.wav','wb');w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(b''.join(struct.pack('<h',int(8000*math.sin(2*math.pi*220*t/16000))) for t in range(48000)));w.close()" && curl -s -m 180 -F audio=@/tmp/eta-vad-smoke.wav http://127.0.0.1:8001/speech_regions | python3 -c "import sys,json;d=json.load(sys.stdin);print('SMOKE OK' if d.get('ok') and d.get('sample_rate')==16000 and d.get('total_samples')==48000 and isinstance(d.get('regions'),list) and d.get('vad_model') else 'SMOKE FAIL',{k:v for k,v in d.items() if k not in ('regions','audio_b64')})"
```

`SMOKE OK` proves the model loaded and the contract shape is right. `SMOKE FAIL` with
`vad_model_unavailable` means Silero is missing (see above). Before the restart it prints
`SMOKE FAIL` / Not Found — which is how you know it discriminates.
