# Filler-text watch: Whisper VAD gate OFF since 04:40 IST 24 Sep (split-speaker, E2E box)

Hourly until 20:00 IST. Counts only, by room id. Runs = room transcripts (`transcription_run`, bench_window, no error) created
since 04:40 IST today; `yday` = the same clock span yesterday, with VAD on. `filler` = the whole transcript is filler
("thank you", "thanks for watching", "bye", "you", "okay"...); `loop` = "thank you" 3+ times in one window; `empty` = blank
after the shim. ALARM when one room has >= 3 filler+loop windows today. The shim's collapse guard runs on the Mini and is not
visible here; these are the windows that got PAST it.

- 06:11 IST | today windows 22 filler 0 loop 0 empty 3 | yday(VAD on) windows 0 filler 0 loop 0 empty 0 | rooms with filler/loop -
- 07:05 IST | today windows 22 filler 0 loop 0 empty 3 | yday(VAD on) windows 0 filler 0 loop 0 empty 0 | rooms with filler/loop -
- 08:05 IST | today windows 23 filler 0 loop 0 empty 3 | yday(VAD on) windows 0 filler 0 loop 0 empty 0 | rooms with filler/loop -
- 09:05 IST | today windows 27 filler 0 loop 0 empty 3 | yday(VAD on) windows 4 filler 0 loop 0 empty 0 | rooms with filler/loop -
- 10:05 IST | today windows 41 filler 0 loop 0 empty 3 | yday(VAD on) windows 13 filler 0 loop 0 empty 0 | rooms with filler/loop -
- 11:05 IST | today windows 66 filler 0 loop 3 empty 3 | yday(VAD on) windows 23 filler 0 loop 1 empty 0 | rooms with filler/loop room_87frpus9:2,room_yh3etjpf:1
- 12:05 IST | today windows 94 filler 1 loop 8 empty 6 | yday(VAD on) windows 32 filler 0 loop 2 empty 0 | rooms with filler/loop room_87frpus9:4,room_yh3etjpf:2,room_ymch4bxu:1,room_qyzghzaf:1,room_jwyrr4dc:1 | **ALARM**: room_87frpus9 4
- 12:05 IST | today windows 94 filler 1 loop 8 empty 6 | yday(VAD on) windows 32 filler 0 loop 2 empty 0 | rooms with filler/loop room_87frpus9:4,room_yh3etjpf:2,room_ymch4bxu:1,room_qyzghzaf:1,room_jwyrr4dc:1 | **ALARM**: room_87frpus9 4
- 13:05 IST | today windows 119 filler 1 loop 10 empty 11 | yday(VAD on) windows 41 filler 0 loop 2 empty 0 | loop rate 8.4% of 119 (trigger: >10% over >=150) | rooms with filler/loop room_87frpus9:4,room_yh3etjpf:2,room_qyzghzaf:2,room_ymch4bxu:1,room_pnyc9u49:1,room_jwyrr4dc:1
- 14:05 IST | today windows 147 empty 9 filler-only 1 | CANONICAL loop windows 11 (7.5%; trigger >10% over >=150) agg repeat_ratio 0.39% ratio>=0.10 6 | B repeated-sentence windows 29 (info only) | yday(VAD on) windows 45 loop windows 1 agg 0.06% | rooms with loop windows room_jwyrr4dc:5,room_yh3etjpf:2,room_ux92qpws:1,room_qyzghzaf:1,room_pnyc9u49:1,room_4ggnkg5x:1 | **ALARM**: room_jwyrr4dc 5 loop windows
- 15:05 IST | today windows 173 empty 12 filler-only 1 | CANONICAL loop windows 13 (7.5%; trigger >10% over >=150) agg repeat_ratio 0.36% ratio>=0.10 7 | B repeated-sentence windows 35 (info only) | yday(VAD on) windows 45 loop windows 1 agg 0.06% | rooms with loop windows room_jwyrr4dc:5,room_yh3etjpf:3,room_4ggnkg5x:2,room_ux92qpws:1,room_qyzghzaf:1,room_pnyc9u49:1 | **ALARM**: room_yh3etjpf 3 loop windows
- 16:05 IST | today windows 199 empty 16 filler-only 1 | CANONICAL loop windows 14 (7.0%; trigger >10% over >=150) agg repeat_ratio 0.33% ratio>=0.10 7 | B repeated-sentence windows 39 (info only) | yday(VAD on) windows 45 loop windows 1 agg 0.06% | rooms with loop windows room_jwyrr4dc:6,room_yh3etjpf:3,room_4ggnkg5x:2,room_ux92qpws:1,room_qyzghzaf:1,room_pnyc9u49:1 | **ALARM**: room_jwyrr4dc 6 loop windows
- 17:05 IST | today windows 229 empty 21 filler-only 1 | CANONICAL loop windows 15 (6.6%; trigger >10% over >=150) agg repeat_ratio 0.31% ratio>=0.10 7 | B repeated-sentence windows 41 (info only) | yday(VAD on) windows 45 loop windows 1 agg 0.06% | rooms with loop windows room_jwyrr4dc:6,room_yh3etjpf:3,room_4ggnkg5x:3,room_ux92qpws:1,room_qyzghzaf:1,room_pnyc9u49:1 | **ALARM**: room_4ggnkg5x 3 loop windows
- 18:05 IST | today windows 256 empty 24 filler-only 1 | CANONICAL loop windows 16 (6.2%; trigger >10% over >=150) agg repeat_ratio 0.28% ratio>=0.10 7 | B repeated-sentence windows 47 (info only) | yday(VAD on) windows 45 loop windows 1 agg 0.06% | rooms with loop windows room_jwyrr4dc:6,room_yh3etjpf:3,room_4ggnkg5x:3,room_ux92qpws:2,room_qyzghzaf:1,room_pnyc9u49:1
