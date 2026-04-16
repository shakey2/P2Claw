/**
 * P2 Claw — env sync helper.
 *
 * Regenerates `.env` from `.env.example` while preserving existing values
 * from the current `.env` (when present). This avoids re-entering secrets
 * when `.env.example` changes or gets reordered.
 *
 * Rules:
 * - Keeps `.env.example` structure/comments as the source of truth.
 * - For each KEY= line in `.env.example`, if `.env` already has a value for KEY,
 *   we use that value.
 * - Leaves commented example keys commented unless the user already had a value.
 * - Appends unknown keys (present in `.env` but not in `.env.example`) at the end.
 *
 * This script prints only counts and file paths — never prints secrets.
 */

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const EXAMPLE_PATH = path.join(ROOT, ".env.example");
const ENV_PATH = path.join(ROOT, ".env");

function readFileOrEmpty(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function parseEnvKV(text) {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1); // keep as-is (may include '=')
    if (!key) continue;
    map.set(key, value);
  }
  return map;
}

function isKeyLine(rawLine) {
  // Matches: KEY=... or # KEY=... (with optional leading whitespace)
  return /^\s*#?\s*[A-Z0-9_]+\s*=/.test(rawLine);
}

function extractKey(rawLine) {
  const m = rawLine.match(/^\s*#?\s*([A-Z0-9_]+)\s*=/);
  return m ? m[1] : null;
}

function main() {
  const example = readFileOrEmpty(EXAMPLE_PATH);
  if (!example) {
    console.error(`env:sync: missing ${EXAMPLE_PATH}`);
    process.exit(1);
  }

  const current = readFileOrEmpty(ENV_PATH);
  const currentMap = parseEnvKV(current);

  /** @type {Set<string>} */
  const seenKeys = new Set();
  let preservedCount = 0;
  let addedCount = 0;

  const outLines = example.split(/\r?\n/).map((rawLine) => {
    if (!isKeyLine(rawLine)) return rawLine;

    const key = extractKey(rawLine);
    if (!key) return rawLine;
    seenKeys.add(key);

    const had = currentMap.has(key);
    if (!had) return rawLine;

    // Use the existing value, and ensure it is not commented out.
    const value = currentMap.get(key);
    preservedCount++;
    return `${key}=${value ?? ""}`;
  });

  // Append any extra keys that were in .env but not in .env.example
  const extraKeys = [...currentMap.keys()].filter((k) => !seenKeys.has(k));
  if (extraKeys.length > 0) {
    outLines.push("");
    outLines.push("# ─── Extra keys (present in .env only) ────────────────────────");
    for (const k of extraKeys) {
      outLines.push(`${k}=${currentMap.get(k) ?? ""}`);
      addedCount++;
    }
  }

  const eol = example.includes("\r\n") ? "\r\n" : "\n";
  fs.writeFileSync(ENV_PATH, outLines.join(eol), "utf8");

  console.log(`env:sync: wrote ${ENV_PATH}`);
  console.log(`env:sync: preserved ${preservedCount} value(s) from existing .env`);
  if (addedCount > 0) {
    console.log(`env:sync: appended ${addedCount} extra key(s) not in .env.example`);
  }
}

main();

