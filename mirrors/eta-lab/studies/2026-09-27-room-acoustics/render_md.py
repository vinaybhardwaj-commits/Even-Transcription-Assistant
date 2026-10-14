#!/usr/bin/env python3
"""W34.2 step 4: render room-profiles JSON to markdown (numbers only). Usage: render_md.py IN.json OUT.md"""
import json, sys
d = json.load(open(sys.argv[1])); P = d["profiles"]; stt = (d.get("stt_route_by_room") or {}).get("rooms", {})
RID = {"OPD 1":"room_yh3etjpf","OPD 3":"room_87frpus9","OPD 4":"room_ux92qpws","OPD 5":"room_4ggnkg5x","OPD 6":"room_pnyc9u49","OPD 7":"room_qyzghzaf",
       "Third Floor":"room_d74hhmc4","Cardiology":"room_bh6jtq4t","Room 4-1 (after cards, before 5)":"room_ymch4bxu","ORB3":"room_jwyrr4dc"}
g = lambda x, k, dflt="-": dflt if x is None or x.get(k) is None else x[k]
L = [f"# Room acoustic profiles, from existing tape (no sound played)", "",
     f"Generated {d['generated']} by acoustics (W34.2). Source: {d['source']}; {d['n_chunks']} five-minute chunks. Numbers only, no transcript text.",
     "Levels are dBFS of the decoded Opus tape (1.0 = full scale). Rooms with two mics are split by the mic in the session row.", "",
     "## Per room and mic", "",
     "| room | mic | h | speech % | noise med (floor p10) | speech dBFS | SNR VAD med (p10-p90) [% chunks] | SNR VAD-free med (p95-p20) | no-VAD chunks % | clip % >=.999 | zero-sample % | mute chunks % | RT60 med s (n) | C50 dB |",
     "|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|"]
for p in P:
    s = p.get("snr_db") or {}; r = p.get("rt60_blind") or {}
    L.append(f"| {p['room']} | {p['mic']} | {p['hours']} | {g(p,'vad_speech_share_pct')} | {g(p,'noise_median_dbfs')} ({g(p,'noise_floor_p10_dbfs')}) | {g(p,'speech_level_dbfs_median')} | "
             f"{g(s,'median')} ({g(s,'p10')} to {g(s,'p90')}) [{g(s,'share_of_chunks_pct')}] | {g(p.get('snr_vad_free_db'),'median')} | {g(p,'chunks_no_vad_speech_pct')} | {g(p,'clip_pct_ge_0.999')} | {g(p,'exact_zero_sample_pct')} | {g(p,'mute_signature_chunk_pct')} | "
             f"{g(r,'median_s')} ({g(r,'n_decays',0)}) | {g(p,'c50_db_from_median_rt60')} |")
L += ["", "**Reading the SNR columns:** the VAD-based SNR describes only the minority of chunks where Silero hears speech (see the [% chunks] and no-VAD columns), so a high VAD SNR does not mean the room is clean. The VAD-free figure is an upper-bound dynamic range, not a speech SNR.",
      "", "## Speech spectrum (does the mic cut highs?)", "",
      "| room | mic | tilt dB/oct (200-4k) | 4-8k vs 0.3-3k dB | 8-16k vs 0.3-3k dB | bandwidth -30 dB Hz | 95% energy below Hz |", "|---|---|--:|--:|--:|--:|--:|"]
for p in P:
    s = p.get("spectrum")
    if s: L.append(f"| {p['room']} | {p['mic']} | {s['tilt_db_per_octave_200_4000']} | {s['hf_4_8k_vs_300_3k_db']} | {s['hf_8_16k_vs_300_3k_db']} | {s.get('bw_minus30db_hz','-')} | {s['f95_energy_rolloff_hz']} |")
    else: L.append(f"| {p['room']} | {p['mic']} | (not enough speech) | | | | |")
L += ["", "## STT route output per room (ties acoustics to CLARITY; NOT garble truth)", "",
      "transcription_run engine=route, room_day ist_date >= 19 Sep; last IST day per room shown. These days do NOT overlap the tape days (route data ends 24 Sep IST).", "",
      "| room | windows | last IST day | en % | non-en % | tiny (<15 chars) % | any Indic script % |", "|---|--:|---|--:|--:|--:|--:|"]
for name, rid in RID.items():
    s = stt.get(rid)
    if s: L.append(f"| {name} | {s['windows']} | {s['ist_days'][-1]} | {s['en_pct']} | {s['nonen_pct']} | {s['tiny_pct']} | {s['indic_script_pct']} |")
L += ["", "## No tape in the lab copy", ""] + [f"- **{n}**: {w}" for n, w in d["no_tape"]]
L += ["", "## Method and limits", "",
      "- Decode: ffmpeg to 48 kHz mono float. Speech = Silero VAD (16 kHz, defaults); quiet = 1-s frames with no VAD speech within 0.3 s. Noise floor = 10th percentile of 1-s RMS over pooled quiet frames (1-dB histogram). Noise level = median quiet-frame dB (p10 shown only as floor; -120 mute bin dropped). SNR (VAD) = chunk speech power dBFS minus median quiet-frame dB, chunks with >=5 s VAD speech; it exists only where VAD found speech, so it is biased high in VAD-starved rooms: read the [% chunks] column. SNR (VAD-free) = p95 minus p20 of 1-s frame dB per chunk, an upper-bound dynamic range that includes non-speech events.",
      "- Silero has documented blind windows (vad-measure REPORT); a room with low speech % may be VAD-blind, not silent.",
      "- Clipping is measured on the decoded Opus (overshoot above 1.0 counts). Exact zero = decoded samples exactly 0; mute chunks = chunks with under 1000 B/s (Opus of digital zero is about 708 B/s).",
      "- Spectrum: Welch PSD (1024) pooled over speech samples. A -30 dB bandwidth well under 8 kHz means the mic/codec path rolls off highs; the Opus tape itself limits the top end.",
      "- RT60 is a blind estimate from the decay after speech offsets (T20 fit, -5 to -25 dB, needs 30 dB above the floor); it is biased low by abrupt consonant stops and unusable in noisy rooms; C50 assumes a diffuse exponential decay. Use for ranking only. Sample count is shown.",
      "- Tape lab copy covers 25-27 Sep only (3 UTC days), not 7."]
open(sys.argv[2], "w").write("\n".join(L) + "\n")
