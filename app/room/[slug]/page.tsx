import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { readRoomCookie, verifyRoomJwt } from "@/lib/room-auth";
import { isRoomSlugShaped } from "@/lib/bench";
import { RoomLoginClient } from "@/components/room/RoomLoginClient";
import { RoomRecorderClient } from "@/components/room/RoomRecorderClient";

/**
 * Room Bench capture surface (Room-Bench PRD §3.3).
 *
 * /room/{slug} — kiosk-style, Chrome on the room Mac Mini. PIN screen
 * visually identical to the doctor one; after login, the recorder surface.
 * Probe-proof like /{slug}: bad pattern or unknown room → real 404.
 * DB errors also degrade to 404 (fail-safe — never a 500 on this page).
 */

export const dynamic = "force-dynamic";

type RoomRow = {
  id: string;
  slug: string;
  name: string;
  disabled_at: Date | string | null;
};

async function findRoom(slug: string): Promise<RoomRow | null> {
  try {
    const rows = (await sql`
      SELECT id, slug, name, disabled_at
        FROM room
       WHERE slug = ${slug}
       LIMIT 1
    `) as RoomRow[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export default async function RoomPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  if (!isRoomSlugShaped(slug)) notFound();
  const room = await findRoom(slug);
  if (!room || room.disabled_at) notFound();

  const jwt = await readRoomCookie();
  let authed = false;
  if (jwt) {
    try {
      const claims = await verifyRoomJwt(jwt);
      if (claims.room_id === room.id && claims.slug === slug) authed = true;
    } catch {
      // bad/expired/doctor-audience cookie — fall through to PIN
    }
  }

  if (authed) {
    return <RoomRecorderClient slug={slug} roomName={room.name} />;
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-6 py-12 bg-even-white">
      <div className="w-full max-w-sm">
        <header className="text-center mb-8">
          <h1 className="text-display text-even-navy-800">Even Hospital</h1>
          <p className="mt-1 text-caption text-even-ink-500">Encounter Assistant</p>
        </header>

        <section
          aria-label="PIN entry"
          className="rounded-xl border border-even-ink-100 bg-even-white p-6 shadow-card"
        >
          <RoomLoginClient slug={slug} roomName={room.name} />
        </section>

        <p className="mt-6 text-caption text-even-ink-400 text-center">
          Patients and staff in this room are recorded under the hospital&apos;s
          IRB-approved protocol.
        </p>

        <p className="mt-4 text-caption text-even-ink-500 text-center">
          Forgot PIN? Contact your administrator.
        </p>
      </div>
    </main>
  );
}
