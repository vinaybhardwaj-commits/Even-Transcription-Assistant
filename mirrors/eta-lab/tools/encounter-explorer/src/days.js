// Doctor x date grid from consult summaries. Shared by every adapter so filters behave the same.
import { completeness, datesBetween, docKey, hasRx } from "./util.js";

export function buildDays(consults, q, truncated = false) {
  const rooms = new Set(), specs = new Set();
  for (const c of consults) { if (c.room_id) rooms.add(c.room_id); if (c.specialty) specs.add(c.specialty); }
  const keep = consults.filter(c =>
    (!q.room || c.room_id === q.room) && (!q.specialty || c.specialty === q.specialty) && (!q.hasRx || hasRx(c)));
  const cells = new Map(), docs = new Map();
  for (const c of keep) {
    const dk = docKey(c), k = dk + "|" + c.ist_date;
    let cell = cells.get(k);
    if (!cell) { cell = { doctorId: dk, doctorName: c.doctor_name, specialty: c.specialty, date: c.ist_date, consults: 0, _sum: 0, completeness: 0, hasRx: false }; cells.set(k, cell); }
    cell.consults++; cell._sum += completeness(c.stages); cell.hasRx = cell.hasRx || hasRx(c);
    if (!docs.has(dk)) docs.set(dk, { doctorId: dk, doctorName: c.doctor_name, specialty: c.specialty });
  }
  const out = [...cells.values()].map(({ _sum, ...c }) => ({ ...c, completeness: c.consults ? _sum / c.consults : 0 }));
  const doctors = [...docs.values()].sort((a, b) => String(a.doctorName || a.doctorId).localeCompare(String(b.doctorName || b.doctorId)));
  return { cells: out, doctors, dates: datesBetween(q.from, q.to), rooms: [...rooms].sort(), specialties: [...specs].sort(), truncated };
}

export function listFor(consults, doctorId, date) {
  return consults.filter(c => docKey(c) === doctorId && c.ist_date === date).sort((a, b) => (a.t_open ?? 0) - (b.t_open ?? 0));
}
