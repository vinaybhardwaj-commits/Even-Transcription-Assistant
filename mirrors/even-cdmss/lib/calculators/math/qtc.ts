// CALC.v1.8 — QTc (corrected QT). Returns Bazett, Fridericia, Framingham + band on Bazett.
// Sex-specific normal bands. Any-method >500 ms → high TdP-risk flag.

export type QtcSex = 'M' | 'F';

export type QtcInputs = {
  qt_ms:   number;            // measured QT in ms (200-700)
  hr_bpm?: number;            // either HR ...
  rr_ms?:  number;            // ... or RR in ms (alternative input)
  sex:     QtcSex;
};

export type QtcBand = 'normal' | 'borderline' | 'prolonged';

export type QtcResult = {
  rr_sec: number;
  bazett_ms: number;
  fridericia_ms: number;
  framingham_ms: number;
  band: QtcBand;              // band on Bazett (the universally-quoted reference)
  band_label: string;
  high_tdp_risk: boolean;     // true if ANY method >500 ms
};

export function computeQtc(i: QtcInputs): QtcResult {
  // Resolve RR (seconds) from either input.
  let rr_sec: number;
  if (typeof i.rr_ms === 'number' && i.rr_ms > 0)       rr_sec = i.rr_ms / 1000;
  else if (typeof i.hr_bpm === 'number' && i.hr_bpm > 0) rr_sec = 60 / i.hr_bpm;
  else throw new Error('qtc requires hr_bpm or rr_ms');

  const bazett     = i.qt_ms / Math.sqrt(rr_sec);
  const fridericia = i.qt_ms / Math.cbrt(rr_sec);
  const framingham = i.qt_ms + 154 * (1 - rr_sec);

  const bazett_ms     = Math.round(bazett);
  const fridericia_ms = Math.round(fridericia);
  const framingham_ms = Math.round(framingham);

  let band: QtcBand;
  let band_label: string;
  if (i.sex === 'M') {
    if (bazett_ms < 430)      { band = 'normal';     band_label = 'Normal (M: <430 ms by Bazett)'; }
    else if (bazett_ms <= 450){ band = 'borderline'; band_label = 'Borderline (M: 430-450 ms by Bazett)'; }
    else                      { band = 'prolonged';  band_label = 'Prolonged (M: >450 ms by Bazett — increased TdP risk)'; }
  } else {
    if (bazett_ms < 450)      { band = 'normal';     band_label = 'Normal (F: <450 ms by Bazett)'; }
    else if (bazett_ms <= 470){ band = 'borderline'; band_label = 'Borderline (F: 450-470 ms by Bazett)'; }
    else                      { band = 'prolonged';  band_label = 'Prolonged (F: >470 ms by Bazett — increased TdP risk)'; }
  }

  const high_tdp_risk = bazett_ms > 500 || fridericia_ms > 500 || framingham_ms > 500;

  return { rr_sec, bazett_ms, fridericia_ms, framingham_ms, band, band_label, high_tdp_risk };
}
