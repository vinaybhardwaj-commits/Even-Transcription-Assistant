/**
 * ETA STT relay — browser <-> Sarvam streaming STT bridge (standalone Node).
 *
 * Browsers can't set the Api-Subscription-Key header on a WebSocket and Vercel
 * can't hold a persistent socket, so this tiny relay (run on the Mac Mini)
 * sits in between: it accepts an authenticated browser WS, opens an upstream
 * WS to Sarvam with the key header, and pipes JSON frames both ways.
 *
 *   browser  --(PCM frames + flush)-->  relay  --(+ Api-Subscription-Key)-->  Sarvam
 *   browser  <--(transcripts/events)--  relay  <--------------------------    Sarvam
 *
 * Auth: the browser must present a short-lived HMAC token (minted by the app's
 * /api/voice/stt-token, signed with STT_RELAY_SECRET). Format:
 *   token = base64url(JSON{slug,exp}) + "." + base64url(HMAC_SHA256(payload))
 *
 * Env: SARVAM_API_KEY (required), STT_RELAY_SECRET (required), PORT (default 8787).
 */
import { WebSocketServer, WebSocket } from "ws";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 8787);
const SARVAM_KEY = process.env.SARVAM_API_KEY;
const SECRET = process.env.STT_RELAY_SECRET;
const SARVAM_WS = process.env.SARVAM_WS_URL || "wss://api.sarvam.ai/speech-to-text/ws";
if (!SARVAM_KEY || !SECRET) { console.error("missing SARVAM_API_KEY or STT_RELAY_SECRET"); process.exit(1); }

const b64urlJson = (s) => JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
function verifyToken(tok) {
  try {
    const [p, sig] = String(tok).split(".");
    if (!p || !sig) return null;
    const expect = crypto.createHmac("sha256", SECRET).update(p).digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const payload = b64urlJson(p);
    if (!payload.exp || Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch { return null; }
}

const ALLOWED = new Set(["language-code","model","mode","sample_rate","input_audio_codec","high_vad_sensitivity","vad_signals","flush_signal"]);
const wss = new WebSocketServer({ port: PORT, path: "/ws" });
console.log(`stt-relay listening on :${PORT}/ws -> ${SARVAM_WS}`);

wss.on("connection", (client, req) => {
  const u = new URL(req.url, "http://x");
  const claims = verifyToken(u.searchParams.get("token"));
  if (!claims) { client.close(1008, "unauthorized"); return; }

  // forward only the allowlisted Sarvam params the browser supplied
  const qp = new URLSearchParams();
  for (const [k, v] of u.searchParams) if (ALLOWED.has(k)) qp.set(k, v);
  if (!qp.has("model")) qp.set("model", "saaras:v3");
  if (!qp.has("mode")) qp.set("mode", "codemix");
  if (!qp.has("language-code")) qp.set("language-code", "unknown");
  if (!qp.has("sample_rate")) qp.set("sample_rate", "16000");
  if (!qp.has("input_audio_codec")) qp.set("input_audio_codec", "pcm_s16le");
  qp.set("vad_signals", "true"); qp.set("flush_signal", "true"); qp.set("high_vad_sensitivity", "true");

  const upstream = new WebSocket(`${SARVAM_WS}?${qp}`, { headers: { "Api-Subscription-Key": SARVAM_KEY } });
  const upQueue = [];
  upstream.on("open", () => { for (const m of upQueue) upstream.send(m); upQueue.length = 0; });
  upstream.on("message", (d) => { if (client.readyState === WebSocket.OPEN) client.send(d.toString()); });
  upstream.on("close", (c) => { if (client.readyState === WebSocket.OPEN) client.close(1000, "upstream_closed"); });
  upstream.on("error", () => { if (client.readyState === WebSocket.OPEN) client.close(1011, "upstream_error"); });

  client.on("message", (d) => {
    const m = d.toString();
    if (upstream.readyState === WebSocket.OPEN) upstream.send(m); else upQueue.push(m);
  });
  client.on("close", () => { try { upstream.close(); } catch {} });
  client.on("error", () => { try { upstream.close(); } catch {} });
});
