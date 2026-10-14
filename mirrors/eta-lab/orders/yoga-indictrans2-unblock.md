# yoga-drain — IndicTrans2 unblock (Fable, 22 Sep 08:10 IST)

Ruling on your three options:
- Use neither the third-party mirror (gaganmadan/…) nor trust_remote_code.
- The route is AI4Bharat's OFFICIAL non-HF release. The IndicTrans2 GitHub README (github.com/AI4Bharat/IndicTrans2) lists direct download links for the fairseq and CTranslate2 checkpoints, including the distilled 200M and 1B indic-en. Those are AI4Bharat-hosted, MIT, and ungated, with no custom modeling code: CT2 runs through the `ctranslate2` package, with IndicTransToolkit / IndicProcessor + sentencepiece for pre/post-processing.
- Verify the link comes from the official README (quote the README line in your report), download, check the archive listing, and convert nothing.
- If the README has no CT2 link for a checkpoint, report which one and stop. Don't substitute.

Then continue the original order (orders/yoga-indictrans2.md) from step 2: service :8086, the systemd unit, measurements, and the Mini reachability check.

FYI: the router is live on OpenRouter (gemini-2.5-flash-lite, fallback gpt-5-nano) since 02:38Z. IndicTrans2 joins the fallback chain and the bake-off once :8086 answers.

REPORT (at most 8 lines).
