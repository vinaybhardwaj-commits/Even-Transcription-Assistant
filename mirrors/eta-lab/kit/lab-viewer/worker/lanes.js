// 6V: which lane a REB track belongs to, in words a medical administrator can read. One table, used by the consult drawer.
// A track that matches no row lands in "other" so nothing the palimpsest holds is silently hidden. Matching is on (layer, engine) only:
// engine names are shown small, under the plain name, never as the heading.
const has = (e, p) => typeof e === "string" && e.startsWith(p);
export const LANES = [
  // key, plain label, one-line help, retired?, match(layer, engine)
  { key: "sarvam", label: "Sarvam transcript", help: "What was said, turn by turn, from the Sarvam speech service", test: (l, e) => l === "stt" && has(e, "sarvam-saaras") },
  { key: "sarvam_translate", label: "Sarvam English translation", help: "The same turns in English", test: (l, e) => l === "translate" && has(e, "sarvam-saaras") },
  { key: "sarvam_diar", label: "Sarvam speaker turns", help: "Who spoke when, from the Sarvam job", test: (l, e) => l === "diar" && has(e, "sarvam-saaras") },
  { key: "encounter", label: "Visit record", help: "The doctor, the prescription and how well the visit was recorded", test: (l) => l === "encounter" },
  { key: "router", label: "Production router (twin)", help: "A copy of what the live system chose to transcribe", test: (l, e) => l === "stt" && has(e, "router-twin") },
  { key: "koyal", label: "Koyal", help: "Indian-language speech model, one reading per language", test: (l, e) => l === "stt" && e === "koyal" },
  { key: "medical", label: "Medical vocabulary", help: "A model tuned for medical words", test: (l, e) => l === "medical" || l === "terms" || (l === "stt" && e === "medasr") },
  { key: "whisper", label: "Whisper", help: "General speech model", retired: true, test: (l, e) => l === "stt" && has(e, "whisper") },
  { key: "indic", label: "IndicConformer", help: "Indian-language speech model", retired: true, test: (l, e) => l === "stt" && (e === "indic-conformer" || has(e, "indic-ctc")) },
  { key: "sravaani", label: "SraVaani", help: "Indian-language speech model", retired: true, test: (l, e) => l === "stt" && e === "sravaani" },
  { key: "translate", label: "English translation (other)", help: "English renderings of the other lanes", test: (l) => l === "translate" },
  { key: "diar", label: "Who spoke when", help: "Speaker turns from the diarization models", test: (l) => l === "diar" },
  { key: "speaker", label: "Speaker identity", help: "Whether a turn is the doctor", test: (l) => l === "speaker" },
  { key: "emotion", label: "Tone", help: "Tone of voice per speaker turn", test: (l) => l === "emotion" },
  { key: "acoustics", label: "Room sound", help: "Loudness and speech detection", test: (l) => l === "acoustics" },
  { key: "other", label: "Other", help: "Anything else the palimpsest holds for this span", test: () => true },
];
export const LANE_BY_KEY = Object.fromEntries(LANES.map((l) => [l.key, l]));
export function laneOfTrack(layer, engine) {
  for (const l of LANES) if (l.test(layer, engine)) return l.key;
  return "other";
}
// the lanes whose segments carry words (blind handling and caps use this)
export const WORD_LANES = new Set(["sarvam", "sarvam_translate", "router", "koyal", "medical", "whisper", "indic", "sravaani", "translate"]);
export const KOYAL_NAMES = { hi: "Hindi", kn: "Kannada", ml: "Malayalam", te: "Telugu" };
