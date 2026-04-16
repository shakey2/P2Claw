/**
 * P2 Claw — RFC 6238 TOTP (Google Authenticator–compatible).
 *
 * HMAC-SHA1, 30-second time step, 6 digits. No third-party deps — uses Node crypto only.
 */

import { createHmac, timingSafeEqual } from "crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const DEFAULT_DIGITS = 6;
const DEFAULT_STEP_SEC = 30;
const DEFAULT_WINDOW = 1;

/**
 * Decodes RFC 4648 Base32 (no padding required; ignores whitespace).
 */
export function decodeBase32(secretBase32: string): Buffer {
  const cleaned = secretBase32.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  if (cleaned.length === 0) {
    throw new Error("Empty Base32 secret");
  }

  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const c of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(c);
    if (idx === -1) {
      throw new Error(`Invalid Base32 character: ${c}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    while (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}

function dynamicTruncate(hmac: Buffer): number {
  const offset = hmac[hmac.length - 1]! & 0x0f;
  return (
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff)
  );
}

function hotp(secret: Buffer, counter: bigint, digits: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);
  const hmac = createHmac("sha1", secret).update(buf).digest();
  const code = dynamicTruncate(hmac) % 10 ** digits;
  return code.toString().padStart(digits, "0");
}

/**
 * Verifies a user-supplied TOTP code against the shared Base32 secret.
 *
 * @param window - accept counter ± window (default 1 = previous/current/next step).
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  nowMs: number = Date.now(),
  window: number = DEFAULT_WINDOW,
  stepSec: number = DEFAULT_STEP_SEC,
  digits: number = DEFAULT_DIGITS
): boolean {
  const normalized = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) {
    return false;
  }

  let secret: Buffer;
  try {
    secret = decodeBase32(secretBase32.trim());
  } catch {
    return false;
  }

  if (secret.length === 0) {
    return false;
  }

  const counter = BigInt(Math.floor(nowMs / 1000 / stepSec));

  for (let w = -window; w <= window; w++) {
    const expected = hotp(secret, counter + BigInt(w), digits);
    const candidateBuf = Buffer.from(normalized, "utf8");
    const expectedStrBuf = Buffer.from(expected, "utf8");
    if (
      candidateBuf.length === expectedStrBuf.length &&
      timingSafeEqual(candidateBuf, expectedStrBuf)
    ) {
      return true;
    }
  }

  return false;
}

export const TOTP_DEFAULT_STEP_SEC = DEFAULT_STEP_SEC;
export const TOTP_DEFAULT_DIGITS = DEFAULT_DIGITS;
export const TOTP_DEFAULT_WINDOW = DEFAULT_WINDOW;
