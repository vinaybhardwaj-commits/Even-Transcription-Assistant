#!/usr/bin/env python3
"""Unit tests for variant D's MinorWeightedBCE and the soft-count loss (ruling 210 / refuter b60b37a review). Run in the NeMo venv:
   python tests/test_minor_weighted_bce.py    (from training/diar-lab)   -> prints PASS n/n"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import torch, torch.nn.functional as F
import train_nemotron as t

torch.manual_seed(0); res = []
def check(name, ok): res.append(bool(ok)); print(("PASS " if ok else "FAIL ") + name)
B, T, C = 2, 200, 8
lab = torch.zeros(B, T, C); lab[0, :150, 0] = 1; lab[0, 150:160, 1] = 1; lab[1, :80, 0] = 1; lab[1, 100:180, 1] = 1
tl = torch.tensor([200, 200]); lg = torch.randn(B, T, C); plain = F.binary_cross_entropy_with_logits(lg, lab)
mk = lambda g=0.5, c=4.0: t.MinorWeightedBCE(g, c)
check("gamma 0 == plain BCE (logits)", abs(float(mk(0.0)(logits=lg, labels=lab, target_lens=tl)) - float(plain)) < 1e-6)
check("cap 1 == plain BCE (logits)", abs(float(mk(0.5, 1.0)(logits=lg, labels=lab, target_lens=tl)) - float(plain)) < 1e-6)
pr = torch.sigmoid(lg); plain_p = F.binary_cross_entropy(pr, lab)
check("gamma 0 == plain BCE (probs path)", abs(float(mk(0.0)(probs=pr, labels=lab, target_lens=tl)) - float(plain_p)) < 1e-5)
w = mk()(logits=lg, labels=lab, target_lens=tl); check("weighted loss > plain when a minor speaker exists", w > plain)
def grad_ratio(mod):
    a = lg.clone().requires_grad_(True); mod(logits=a, labels=lab, target_lens=tl).backward()
    b = lg.clone().requires_grad_(True); F.binary_cross_entropy_with_logits(b, lab).backward(); return a.grad, b.grad
g, g0 = grad_ratio(mk())
check("minor speaker positive-frame gradient x3.873 = (150/10)^0.5", abs(float((g[0, 150:160, 1] / g0[0, 150:160, 1]).mean()) - 15 ** 0.5) < 1e-3)
check("major speaker gradient x1.00", abs(float((g[0, :150, 0] / g0[0, :150, 0]).mean()) - 1.0) < 1e-4)
check("equal-talk item gradient x1.00", abs(float((g[1, :80, 0] / g0[1, :80, 0]).mean()) - 1.0) < 1e-4)
neg = (lab == 0); check("negatives are not re-weighted", float((g[neg] / g0[neg]).nan_to_num(1.0).sub(1.0).abs().max()) < 1e-3)
perm = torch.randperm(C); check("permuting channels of labels+logits leaves the loss unchanged", abs(float(mk()(logits=lg[:, :, perm], labels=lab[:, :, perm], target_lens=tl)) - float(w)) < 1e-6)
tl2 = torch.tensor([200, 120]); lg2 = lg.clone(); lg2[1, 120:] = 99.0; lab2 = lab.clone(); lab2[1, 120:, :] = 1.0
a1 = mk()(logits=lg, labels=lab, target_lens=tl2); a2 = mk()(logits=lg2, labels=lab2, target_lens=tl2)
check("padding frames past target_lens do not change the loss (S_k counts valid frames only)", abs(float(a1) - float(a2)) < 1e-6)
# soft-count loss: leak case (refuter #609): soft looks fine, sharp penalises; perfect count -> ~0
tg = torch.zeros(2, 100, 8); tg[0, :30, 0] = 1; tg[0, 30:60, 1] = 1; tg[0, 60:90, 2] = 1; tg[1, :50, 0] = 1; tl3 = torch.tensor([100, 100])
p = torch.full((2, 100, 8), 0.01); p[0, 10, 0] = .9; p[0, 40, 1] = .9; p[0, 70, 2] = .3; p[0, 71, 3] = .3; p[0, 72, 4] = .2; p[0, 73, 5] = .2; p[1, 10, 0] = .95
check("leak case: sharp count loss > soft count loss", float(t.soft_count_loss(p, tg, tl3, "sharp", 0.1)) > float(t.soft_count_loss(p, tg, tl3, "soft")) + 0.1)
check("perfect count -> ~0 loss", float(t.soft_count_loss(tg.clone().clamp(1e-4, 1 - 1e-4), tg, tl3)) < 1e-3)
print(f"{'PASS' if all(res) else 'FAIL'} {sum(res)}/{len(res)}"); sys.exit(0 if all(res) else 1)
