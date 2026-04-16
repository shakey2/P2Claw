/**
 * Kill P2 Claw dev/watch processes without starting the bot.
 *
 * Goal: after agent automation, leave *no* P2 Claw-related Node PIDs running.
 * This is intentionally conservative: it only targets processes whose command line
 * clearly points at this repo + tsx + src/index.ts.
 */

import { execFileSync } from "child_process";

function runPowerShell(command) {
  return execFileSync(
    "powershell",
    ["-NoProfile", "-Command", command],
    { encoding: "utf8" }
  );
}

function main() {
  if (process.platform !== "win32") {
    console.error("dev:clean is currently implemented for Windows only.");
    process.exit(1);
  }

  const repoRoot = process.cwd().replace(/\\/g, "\\\\");

  // Find node.exe processes whose command line contains:
  // - this repo root
  // - tsx
  // - src/index.ts
  const listCmd =
    "Get-CimInstance Win32_Process | " +
    "Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine } | " +
    `Where-Object { $_.CommandLine -match '${repoRoot}' -and $_.CommandLine -match 'tsx' -and $_.CommandLine -match 'src\\\\index\\\\.ts' } | ` +
    "Select-Object ProcessId, CommandLine | ConvertTo-Json -Depth 2";

  let raw = "";
  try {
    raw = runPowerShell(listCmd).trim();
  } catch (err) {
    console.error("Failed to list processes:", err?.message ?? String(err));
    process.exit(1);
  }

  if (!raw) {
    console.log("dev:clean: no matching P2 Claw dev processes found.");
    return;
  }

  /** @type {Array<{ProcessId:number, CommandLine:string}>} */
  const procs = JSON.parse(raw);
  const arr = Array.isArray(procs) ? procs : [procs];
  const pids = arr.map((p) => p.ProcessId).filter((n) => typeof n === "number");

  if (pids.length === 0) {
    console.log("dev:clean: no matching P2 Claw dev processes found.");
    return;
  }

  // Kill them.
  const killCmd = `Stop-Process -Id ${pids.join(",")} -Force -ErrorAction SilentlyContinue`;
  runPowerShell(killCmd);

  console.log(`dev:clean: killed ${pids.length} process(es): ${pids.join(", ")}`);
}

main();

