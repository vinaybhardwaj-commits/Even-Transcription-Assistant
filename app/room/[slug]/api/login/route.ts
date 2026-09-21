/**
 * /room/{slug}/api/login — RETIRED.
 *
 * Room Bench PIN auth used to live here (Room-Bench PRD D5/§9.3). Every room
 * now records with the native Room Recorder app, so this endpoint must never
 * issue another room login: a leftover Chrome tab on a room Mac that submits
 * a PIN here must NOT get a session — that session would become a second,
 * unwanted listener for the room's commands. Every method returns 410 Gone
 * with an empty body: no DB lookup, no bcrypt check, no JWT minted, no
 * cookie set.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function gone() {
  return new NextResponse(null, { status: 410 });
}

export async function GET() {
  return gone();
}

export async function POST() {
  return gone();
}

export async function PUT() {
  return gone();
}

export async function PATCH() {
  return gone();
}

export async function DELETE() {
  return gone();
}

export async function HEAD() {
  return gone();
}

export async function OPTIONS() {
  return gone();
}
