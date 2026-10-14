# Jev across ETA: bench the winners on REAL data (Fable, 23 Sep 09:45)

Synthetic wording trials are done: ~/dev/_fable/scratch/jev-opp/TRIALS-23-SEP.md (35 calls, $0.001).
STRONG: U1 consult phase, U2 consult start/end, U3 speaker role from content, U4 note faithfulness,
U6 clinical-or-not, U8 note completeness. PROMISING: U5 cleanup safety, U7 self-identification.
Synthetic fixtures written by the same agent are the EASY case. Nothing gets wired until each use is
benched on real data with recall, precision, calibration (reliability bins), cost and latency - the
jev-decisions skill's "bench before wiring" rule. Use the winning wording ids from the trials file as
prompt_version v1; store prompt_version with every answer. Transcript text never enters your context,
files, logs or the ledger (pipe state straight to ~/dev/even-jev-mcp/run.sh as the skill shows; V has
cleared transcript text to the vendor). Non-English text is translated first (the live Jev-English path).

## B1 - U3 speaker role vs V's own labels (yoga-drain, after the per-turn embedding rescore)
V labelled 83 clips today (doctor / patient / family / nurse / other doctor / two voices / can't tell),
mapped to turns by SHA in recovered_mapping.json. For each labelled turn that has stored transcript text,
ask U3 with the previous and next turn as context. Report agreement with V per class, confusion matrix,
and - the key question - whether content-role SPLITS the 7 mixed-label voice clusters the Refuter found
(turns V called doctor vs not, inside one diarized cluster). Counts only.

## B2 - U4 note faithfulness by perturbation (lx, after the encounter-path root cause)
Take real generated notes with their source transcripts. For each note, make perturbed copies of
single sentences: dose swap, frequency change, drug substitution, invented finding, dropped negation.
Recall = perturbed sentences flagged unsupported. Precision proxy = unperturbed sentences flagged
(each flag is a candidate real unfaithful sentence - count them, do not read them; queue 10 for V).
Report recall per perturbation type, the unperturbed flag rate, calibration, cost per note, latency.

## B3 - U1 phase + U2 boundaries + U6 clinical-or-not (scribe3, fold into J-C)
Run on real 60 s probe windows alongside J-C, same days. Compare with the E-4 smoother's boundaries in
counts. Accuracy waits on V's ground-truth choice (E-7).

All: branch-free (bench scripts under ~/dev/_fable/scratch/jev-bench/), no production change,
report at most 8 lines each, stop for Fable.
