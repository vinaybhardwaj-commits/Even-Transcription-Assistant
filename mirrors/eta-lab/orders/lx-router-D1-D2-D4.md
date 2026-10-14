# lx — Builder: router translate hardening, D1/D2/D4 plus the override (Fable, 22 Sep 08:25 IST)

J-B is parked. V may clear it later; don't retry it.

CONTEXT
~/eta-router main = ad4a7d8, LIVE since 02:49Z. ETA-Refuter's verdict is in ~/dev/Even-Transcription-Assistant/docs/handoff/ETA-TRANSLATE-BACKENDS-REFUTER-22-SEP-2026.md. Read §§3–5 and the D4 section.

BUILD (worktree off ~/eta-router main; branch vinay/translate-hardening)
1. **D1:** openrouter_translate must catch AttributeError, and any non-string `message.content`, as a failure that falls through to the next engine. Copy the indictrans2 sibling's exception handling (:326). Better: one shared guard so a backend can never raise out of translate().
2. **D2:** a wall-clock deadline around each backend call (ETA_OPENROUTER_TIMEOUT becomes a total bound). A trickle-byte fake at 0.5 s/byte against a 1 s deadline must fail at about 1 s, not succeed at 8 s.
3. **D4:** block the English skip when a segment contains common romanised-Hindi/Kannada tokens:
   - hai, hain, nahi, nahin, kya, kaise, aap, aapko, mujhe, mera, meri, kitne, din, se, ko, ka, ki, ke, bhi, toh, tho, haan, accha, theek, dard, bukhar, dawai, goli, beta, amma, appa, illa, beku, maadi, yenu, hogi, hoga, raha, rahi, wala;
   - extend the list from ETA-Refuter's 6 failing cases.
   - Rule: skip only if verified English (existing rule) AND zero blocklisted tokens. All 10 of ETA-Refuter's synthetic cases must translate, and true English must still skip. Don't block on single common English-overlap words ("to", "is", "the").
4. **Override:** the per-request `translate_engine` must accept only engines in an allow-list: the configured default, the fallback chain, and `indictrans2`. `ollama:*` gets rejected with translate_error (the router has no auth).
5. Tests for each, then run the full test_translate suite. Mutate each new guard once.
6. Commit. Report the hash. Don't deploy; Fable deploys between windows.

DON'T
- Touch production main, the plist, or ollama.
- Print patient text or the key.

REPORT: at most 6 lines.
