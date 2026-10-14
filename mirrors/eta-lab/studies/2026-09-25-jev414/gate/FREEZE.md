# calib30 gate: frozen inputs (recorded before any V label)

Scorer: score_gate.py, frozen at 065c1e9 (sha256 4a4b50f1b673c6bb...), weights POP_L / POP_B lines 60-61.

## Weights source (#2880), re-verified on the box 25 Sep 2026 (#2951)
- label200_jev.json  sha256 59919a18...  mode 600  n=200
- ba106_jev.json     sha256 a6ad2540...  mode 600  n=106
Counts equal POP_L / POP_B.

## calib30 (draw1), lab-viewer f1c4652..b53acc8, reproduced by eta-refuter-2 (#2943)
- seed_docs.json     sha256 71d7669f...
- clip.json          sha256 611d7cfb... (6402348 key fix; was f45ab7c1, same 30 ids and i/t0/t1, only k changed; refuter-2 #2992)
- jev_sidecar.json   sha256 57fc41d4799f98ff... (box, 0600)

## calib30b (top-up, Fable 417b), drawn before any V label, not pushed
IN FORCE: topup2, drawn by make_calib30.py --topup-from @6402348 (unchanged in 69afc74): replays the base
draw on the SAME Random(414) and refuses unless the replay gives the drawn 30, then pops the extras on that rng.
Box ~/eta-data/readability/calib30/topup2/, dir 0700, files 0600.
- ids.json           sha256 ac4cf00857b07ec656d1523ba284cb7369a788c452bde2dee4dc48e0941dfbf4
- jev_sidecar.json   sha256 9267d54a4a93fced24c9dfd844db25a1f7e2317b3561371047ef465381802883
- seed_docs.json     sha256 68e4711e86a6bb67...
- clip.json          sha256 08e9feea49341f9d3752df806f696e51b029ce14b3c412b3f29d3fe52418769e
Checked on the box: 10 ids, unique, 7 L + 3 P, 0 overlap with draw1's 30, sidecar keys == ids.
Reproduced independently by eta-refuter from a clean copy of 69afc74 (--jev jev_all306.json, --flags flag_refs.json,
--topup-from draw1): ids, sidecar and clip shas identical; the replay guard passed.

SUPERSEDED, never to be used: topup1 (4c45f08; ids 1058c4bc..., sidecar 2e6c5837...), now in
topup1-discarded-3seg-k/. Its P came from a fresh Random(414), not the base stream, and its clip keys had 3 segments.
topup2 shares 2 L ids with topup1 and no P ids.

## At scoring time
Re-check every sha above first. Any mismatch: no GATE line, flag to Fable.
Top-up (only on a Fable ruling): merge draw1 + topup1 ids into one --items file and the two exports into one --v file;
the scorer refuses duplicates, unknown ids, and totals other than 30 or 40.
