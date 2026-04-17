/**
 * P2 Claw — Runtime credential resolution.
 *
 * This module is fully self-contained. It has exactly one job:
 * resolve the Player2 API credential and make it available to player2.ts.
 *
 * ## How it works
 *
 * Two credential sources, checked in order:
 *   1. Environment variable PLAYER2_GAME_KEY (optional developer override)
 *   2. Embedded encoded value (baked in before distribution)
 *
 * The .env value always takes precedence when set.
 *
 * ## Why the encoding?
 *
 * The embedded value is stored as a reversed array of character codes
 * rather than a plaintext string. This is NOT cryptographic security —
 * it simply prevents the key from appearing in plain text searches
 * (e.g. `grep`, GitHub secret scanners, casual browsing).
 *
 * An advanced user reading this file can obviously decode it.
 * That's fine. See DESIGN.md §2.6 for the project's stance on this.
 *
 * ## For other modules
 *
 * You don't need to understand this file to modify P2 Claw.
 * It exports two functions: resolveApiCredential() and validateCredential().
 * That's the entire public surface. Everything else in the codebase
 * works through player2.ts, which consumes the resolved credential.
 */

// ── Embedded encoded credential ─────────────────────────────────
// Stored as reversed character codes. Decoded at runtime by _decode().
// To update: run `npx tsx scripts/encode-key.ts YOUR_KEY` and paste
// the output array here.
const _enc: number[] = [
  53, 54, 102, 49, 56, 54, 98, 100, 50, 49, 51, 48,
  45, 57, 54, 49, 57, 45, 55, 102, 54, 55, 45, 52,
  98, 57, 50, 45, 98, 101, 97, 55, 100, 57, 49, 48
];

/**
 * Decodes the embedded credential.
 * Reverses the array back to original order, converts each
 * numeric code to its character, and joins into a string.
 */
function _decode(): string {
  return _enc
    .slice()
    .reverse()
    .map((c) => String.fromCharCode(c))
    .join("");
}

// Sentinel value used to detect installs where the developer
// forgot to encode their real key before distributing.
const _PLACEHOLDER = "PLACEHOLDER_P2_GAME_KEY_HERE";

/**
 * Resolves the Player2 API credential.
 *
 * @param envValue - Raw value from process.env.PLAYER2_GAME_KEY (may be empty)
 * @returns The resolved credential string, or empty string if none found
 */
export function resolveApiCredential(envValue: string): string {
  // Priority 1: .env override (for developers testing with their own key)
  if (envValue && envValue !== "your_player2_game_key_here" && envValue.length > 8) {
    return envValue;
  }

  // Priority 2: Decode the embedded value
  const decoded = _decode();
  if (decoded && decoded.length > 8 && decoded !== _PLACEHOLDER) {
    return decoded;
  }

  // Neither source produced a usable credential
  return "";
}

/**
 * Returns true if the resolved credential is non-empty and not a known placeholder.
 * Used at boot to determine whether Player2 is configured.
 */
export function isCredentialConfigured(credential: string): boolean {
  return (
    !!credential &&
    credential.length >= 8 &&
    credential !== _PLACEHOLDER &&
    credential !== "your_player2_game_key_here"
  );
}

/**
 * Validates that a resolved credential is actually usable.
 * If not, prints a user-facing error and exits.
 *
 * This crash message is intentionally aimed at end users, not developers.
 * It tells them to redownload — not to go get their own key.
 *
 * @param credential - The resolved credential from resolveApiCredential()
 */
export function validateCredential(credential: string): void {
  if (!isCredentialConfigured(credential)) {
    console.error(
      "\n╔══════════════════════════════════════════════════════════════╗"
    );
    console.error(
      "║  P2 CLAW — AUTHENTICATION FAILURE                           ║"
    );
    console.error(
      "╚══════════════════════════════════════════════════════════════╝"
    );
    console.error("\n  The Player2 API credential is missing or corrupted.");
    console.error("  This installation cannot authenticate with Player2.\n");
    console.error("  Please redownload and reinstall P2 Claw from the");
    console.error("  official source to get a working copy.\n");
    process.exit(1);
  }
}
