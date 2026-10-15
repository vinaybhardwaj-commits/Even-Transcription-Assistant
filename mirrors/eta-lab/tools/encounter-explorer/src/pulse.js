// Link into the Pulse prescription page. Both ids must exist, otherwise there is no link.
export function buildPulseLink(prescriptionUid, individualUid) {
  const ok = v => typeof v === "string" && v.trim() !== "";
  if (!ok(prescriptionUid) || !ok(individualUid)) return null;
  return "https://pulse.even.in/prescription?prescription_uid=" + encodeURIComponent(prescriptionUid.trim()) +
    "&individual_uid=" + encodeURIComponent(individualUid.trim());
}
