/**
 * The Ed25519 public key that verifies Room Steward repair tickets (lib/steward/tickets.ts). Committed on purpose: a kiosk pins it, so a leaked
 * database or a compromised endpoint cannot mint a ticket. The private half lives in Vercel env STEWARD_TICKET_PRIVATE_KEY and, on the Mini, at
 * ~/oc/eta-steward/ticket-private.pem (0600). Rotating the key means a new constant here AND a new kiosk build.
 *
 * STEWARD_TICKET_KEY_ID = first 8 hex of sha256 of the DER (SPKI) public key; tests assert it matches the PEM.
 */
export const STEWARD_TICKET_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAgNWhOdzRnAxIYueVlkBbGV9TLdG9G71rO/tSIDwB4jI=
-----END PUBLIC KEY-----
`;

export const STEWARD_TICKET_KEY_ID = "6275a79b";
