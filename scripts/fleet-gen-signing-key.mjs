#!/usr/bin/env node
// Prints a fresh Ed25519 fleet command-signing keypair. Store the PRIVATE line in the deploy environment as FLEET_COMMAND_SIGNING_KEY (never in the repo, never in chat);
// compile the PUBLIC line into the helper as the key for the id you set in FLEET_COMMAND_SIGNING_KEY_ID (fk1 or fk2).
import { generateKeyPairSync } from "node:crypto";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
console.log("FLEET_COMMAND_SIGNING_KEY=" + privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"));
console.log("PUBLIC_KEY_B64=" + publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"));
