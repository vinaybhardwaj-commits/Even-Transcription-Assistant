/** Minimal room tables for the spine artefact pg tests (the real ones come from migrations the spine tests do not load): only the columns the room-access reader reads. */
export const ROOM_STUBS_SQL = `CREATE TABLE IF NOT EXISTS room_day (id text PRIMARY KEY, ist_date date NOT NULL, room_id text NOT NULL);
CREATE TABLE IF NOT EXISTS bench_window (id text PRIMARY KEY, room_day_id text);
CREATE TABLE IF NOT EXISTS room_diarize_window (window_id text, room_day_id text);`;
