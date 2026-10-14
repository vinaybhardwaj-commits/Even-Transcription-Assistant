# Zen spend meter + credit ledger (W25 P0, Fable rulings 407 / 407a / 407b)

`zen_meter.py` reads each host's OpenCode database read-only (box, Mini, Air; Yoga is NOT MEASURED until its ssh host key is trusted by someone who owns that decision) and writes:
- `ZEN-SPEND.md`: credit ledger, **$ per pane per hour**, daily total (IST day), by model, not-Zen spend (openrouter) shown apart. Live copy goes to the Mini at `/Users/vinaybhardwaj/dev/zen-meter/ZEN-SPEND.md`.
- `zen-meter.jsonl`: one line per cycle (remaining, spent, burn/h, today, host status, alert count).
- Alerts to conductor (`hsend`, `NF|` prefix): `ZEN CREDIT LOW <remaining> <burn/day>` when remaining < $10 OR the trailing-3h burn projects to run out within 24 h (once on entry, a reminder every 6 h, `ZEN CREDIT OK` on a clear recovery); `ZEN DAILY CAP 80%` / `CAP REACHED` once each per IST day when `daily_cap_usd` is set in `config.json` (r407b: no cap is set).

**What "cost" means.** Zen replies carry token counts only: no cost field, no cost/credit/balance header (measured 25 Sep). OpenCode multiplies tokens by its catalogue price, which matches Zen's published prices. Every figure here is computed; the Zen console balance is the only ground truth. Record it with `zen_meter.py --checkpoint <balance>`: the ledger re-bases from the latest checkpoint. Record a top-up with `--topup <usd credited>` (the card fee, 4.4% + $0.30, is not credit). Both append; nothing is edited.

**What it reads.** One SQL statement (`SQL` in `zen_meter.py`): time, provider, model, agent, cost, token counts, and the session's directory, for assistant messages only. It never names the prompt/part/title/credential/account tables (a test asserts it), so no text, patient identity or key can reach a log, the report or a message.

**Per pane.** pane = the OpenCode agent name when it is not a default agent (`build`, `plan`, `general`, `explore`); else the session directory matched against `pane_map` in `config.json` (defaults: fleet-watch, linker-oc = `/home/eta/dev/eta-lab`, scratch = `/tmp/`); else `dir:<basename>`. **Every migrated pane should run `opencode --agent <pane>-oc`** so the meter needs no map. Two panes that share a directory and run the default agent cannot be told apart: they show as one pane.

**Safety.** Real sinks (Mini copy, conductor) need `MODE` = `live` in `$ZEN_METER_HOME` and the loop's lock free (a one-off run refuses if the loop holds it). Without `--dry` and without MODE=live it exits 4. Tests use a synthetic database, a fake remote and a fake notifier; nothing reaches a real host.

Run: `python3 zen_meter.py --once --dry` (files under `$ZEN_METER_HOME/dry/`), `--loop`, `--emit --since MS` (what the ssh collector runs), `--topup`, `--checkpoint`, `--selftest`. Prices: `python3 zen_prices.py` writes `board/ZEN-PRICES.md`; `access.json` holds the measured model access on V's account.
