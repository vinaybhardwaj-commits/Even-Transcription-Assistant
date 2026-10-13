export type Row = { patient_name: string; uhid: string; transcript: string }
const sql = "SELECT patient_name, uhid FROM t"
