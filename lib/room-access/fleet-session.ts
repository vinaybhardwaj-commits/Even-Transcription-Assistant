/**
 * lib/room-access/fleet-session.ts — the ONE read of bench_session the fleet control plane makes (TS-H5 #42 server-side gate): does this room have an open session
 * (recording or paused) right now? A boolean only: no session id, no times, no content. Takes the caller's `sql` so the enqueue path stays testable.
 */
type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

export async function roomHasOpenSession(sql: Sql, roomId: string): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM bench_session WHERE room_id = ${roomId} AND status IN ('recording', 'paused') LIMIT 1`;
  return rows.length > 0;
}
