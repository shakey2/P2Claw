/**
 * P2 Claw — Key Encoder Utility
 *
 * Run this script to encode your Player2 Game Key into the
 * char-code array format used in security.ts.
 *
 * Usage:
 *   npx tsx scripts/encode-key.ts YOUR_GAME_KEY_HERE
 *
 * It will output the exact array to paste into security.ts.
 */

const key = process.argv[2];

if (!key || key === "YOUR_GAME_KEY_HERE") {
  console.error("\n╔══════════════════════════════════════════════════════════════╗");
  console.error("║  P2 Claw — Key Encoder                                      ║");
  console.error("╚══════════════════════════════════════════════════════════════╝\n");
  console.error("  Usage:");
  console.error("    npx tsx scripts/encode-key.ts YOUR_REAL_GAME_KEY\n");
  console.error("  Where to find your key:");
  console.error("    https://player2.game/profile/developer → Your game → Game Client ID\n");
  process.exit(1);
}

// Encode as char codes
const charCodes = Array.from(key).map((c) => c.charCodeAt(0));

// Reverse the array for an extra layer of obfuscation
const reversed = [...charCodes].reverse();

console.log("\n╔══════════════════════════════════════════════════════════════╗");
console.log("║  P2 Claw — Key Encoder                                      ║");
console.log("╚══════════════════════════════════════════════════════════════╝\n");
console.log(`  Key length: ${key.length} characters`);
console.log(`  Encoded as: ${reversed.length} char codes (reversed)\n`);
console.log("  ┌─────────────────────────────────────────────────────────┐");
console.log("  │  Copy the array below and paste it into:               │");
console.log("  │  src/security.ts → replace the _enc array              │");
console.log("  └─────────────────────────────────────────────────────────┘\n");

// Format into lines of 12 values for readability
const lines: string[] = [];
for (let i = 0; i < reversed.length; i += 12) {
  const chunk = reversed.slice(i, i + 12);
  lines.push("  " + chunk.join(", "));
}

console.log(`const _enc: number[] = [\n${lines.join(",\n")}\n];\n`);

console.log("  ⚠️  IMPORTANT: After pasting, rebuild and test the bot.");
console.log("     The .env PLAYER2_GAME_KEY will still override this if set.\n");
