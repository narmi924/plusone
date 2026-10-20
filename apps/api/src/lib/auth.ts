import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { buyers } from "../db/schema.js";

// Buyers are identified by a random token kept in their browser; the server only
// stores its digest. The seller console uses one token derived from the password.

export function newBuyerToken() {
  const token = randomBytes(24).toString("base64url");
  return { token, tokenHash: digest(token) };
}

export function digest(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function buyerFromToken(db: Db, token: string | undefined | null) {
  if (!token) return null;
  const [buyer] = await db
    .select()
    .from(buyers)
    .where(eq(buyers.tokenHash, digest(token)));
  return buyer ?? null;
}

export function sellerTokenFor(password: string) {
  return createHmac("sha256", password).update("plusone-seller-console").digest("base64url");
}

export function isSellerToken(password: string, token: string | undefined | null) {
  if (!token) return false;
  const expected = Buffer.from(sellerTokenFor(password));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function bearer(header: string | undefined) {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}
