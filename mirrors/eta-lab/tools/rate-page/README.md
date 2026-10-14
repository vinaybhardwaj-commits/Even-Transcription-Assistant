# Rating page for the lab viewer (ruling 349)

ONE page, two sets, behind the lab viewer's Access: `label200` (the 337c 200-line blind label sample: readable / romanised_readable /
garbled / wrong_language / unsure) and `rate20` (the 337f 20 excerpts: Readable / Useful / Wrong language / Garbled, + English right when an
excerpt has English). Raters: V and Sandhya. It replaces the two claude.ai-artifact pages (`../segment-label`, `../readability-rate`, kept as the tested
originals and seed builders). Owner surg-page builds the UI; **lab-viewer hosts and adds the endpoints**; nothing here ships until refuter-2 has read the contract.

## Files
* `rate.js`, `rate.css`: the UI. Plain DOM, text via `textContent` only, no `innerHTML`, no style attributes (only CSSOM), no fonts, no external
  request: it runs under the viewer's own CSP (`default-src 'none'; script-src/style-src nonce; connect-src 'self'`).
* `build_ui.py` -> **`rate-ui.js`**: an ES module in the style of `kit/lab-viewer/worker/ui.js`: `export const RATE_CSS`, `RATE_JS`, `export function rateShell(nonce)` = the whole HTML page. Wiring is one line in the Worker router:
  `if (path === "/rate") return new Response(rateShell(nonce), {headers: <same headers/CSP as "/">})`; a link to `/rate` can be added to the Days nav.
* `mock-server.mjs` + `browser-check.sh/.js`: the proposed API mocked (whitelisting on read, validation on write, viewer CSP header) and a real-Chromium
  check at 375 px touch + 1280 px, light + dark. It also fails on any CSP violation, console error or external request.

## API the page calls (lab-viewer's proposal #2003, plus the shapes I assumed)
* `GET /api/rate/sets` -> `[{set:"label200", n:200},{set:"rate20", n:20}]` (tab order = array order).
* `GET /api/rate/<set>` -> label200: `[{id, n, lang, dur_s, text}]`; rate20: `[{id, lines:[{t:"HH:MM:SS", lang, text, en?}]}]`. The page re-whitelists.
* `PUT /api/rate/<set>/<id>`, JSON body = the item's whole current answer, resent on every change (debounced 0.6 s; the server overwrites):
  label200 `{label, note?}`; rate20 `{readable?, useful?, wrong_lang?, garbled?, english_right?, note?}` with values
  readable yes|partly|no; useful yes|little|no; wrong_lang no|some|most; garbled none|some|much; english_right yes|no. A partial body (some questions answered) must be accepted.
* `GET /api/rate/<set>/mine` -> the caller's own answers as an object `{<id>: {label,note} | {readable,…}}` (an array of `{id,…}` is also read).
* 403 on PUT/GET = "not on the list of raters" (shown as such). No submit endpoint is used: the page says answers save as you go.
Seeds: `~/eta-data/readability/r1/label-page-seed/seed_docs.json` (`rows`, docs L001..L200 in the sheet's shuffled order, sha256 prefix 6984762fa29393de) and
`~/eta-data/readability-rate/seed1/seed_docs.json` (`excerpts`, R01..R20, sha256 prefix a01e150a682b0584). The private `key.json` files stay with their owners.
Both real seeds load in the mock harness (200 and 20 items, 0 errors).
