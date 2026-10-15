// Stand-in audio for the mockup: a silent track with a short tone blip at every transcript line (pitch by role).
// Rendered with WebAudio's OfflineAudioContext when present, by hand otherwise, and returned as a WAV Blob. Nothing is embedded in the page.
const RATE = 8000, MAX_SEC = 900, BLIP = 0.3;
const HZ = { doctor: 523, patient: 330, attendant: 392 };

export function audioPlan(lengthSec, transcript) {
  const dur = Math.max(5, Math.min(MAX_SEC, Math.round(lengthSec || 60)));
  const cues = (transcript || []).filter(l => l.t0 < dur).map(l => ({ t0: l.t0, hz: HZ[l.role] || 440 }));
  return { dur, cues };
}

export async function synthWav({ dur, cues }) {
  const n = dur * RATE;
  let pcm;
  if (typeof OfflineAudioContext !== "undefined") {
    const ctx = new OfflineAudioContext(1, n, RATE);
    for (const c of cues) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = c.hz; g.gain.setValueAtTime(0, c.t0); g.gain.linearRampToValueAtTime(0.25, c.t0 + 0.03); g.gain.linearRampToValueAtTime(0, c.t0 + BLIP);
      o.connect(g); g.connect(ctx.destination); o.start(c.t0); o.stop(c.t0 + BLIP + 0.05);
    }
    pcm = (await ctx.startRendering()).getChannelData(0);
  } else {
    pcm = new Float32Array(n);
    for (const c of cues) {
      const a = Math.floor(c.t0 * RATE), b = Math.min(n, Math.floor((c.t0 + BLIP) * RATE));
      for (let i = a; i < b; i++) pcm[i] = 0.25 * Math.sin(2 * Math.PI * c.hz * (i - a) / RATE) * Math.min(1, (b - i) / (0.03 * RATE));
    }
  }
  return wavBlob(pcm);
}

/** 8 kHz mono 8-bit: a 15-minute track is 7 MB, not 14. */

export function wavBlob(pcm) {
  const buf = new ArrayBuffer(44 + pcm.length), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + pcm.length, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, "data"); v.setUint32(40, pcm.length, true);
  for (let i = 0; i < pcm.length; i++) v.setUint8(44 + i, Math.round(128 + Math.max(-1, Math.min(1, pcm[i])) * 127));   // unsigned 8-bit, silence = 128
  return new Blob([buf], { type: "audio/wav" });
}
