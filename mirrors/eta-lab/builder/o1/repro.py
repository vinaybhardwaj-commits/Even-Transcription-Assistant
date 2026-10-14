# Step 1: baseline reproduction, run3 snr 10/5/0, both mics, full file, A/B truncated to common length like stress_score.py.
import sys; sys.path.insert(0,"."); from baseline_scorer import *
L="/var/lib/orb3-lab/"; exp={10:(29.2,37.2),5:(59.9,49.6),0:(85.4,83.9)}
for snr,(ea,eb) in exp.items():
    a=load(L+f"run3/micA_snr{snr}.wav"); b=load(L+f"run3/micB_snr{snr}.wav"); n=min(len(a),len(b)); a,b=a[:n],b[:n]
    wa,wb=wer_full(a),wer_full(b)
    print(f"snr {snr:+d} A {wa:.1f} (exp {ea}, d {wa-ea:+.1f}) B {wb:.1f} (exp {eb}, d {wb-eb:+.1f}) {'OK' if abs(wa-ea)<=1.0 and abs(wb-eb)<=1.0 else 'FAIL'}",flush=True)
print("REPRO_DONE")
