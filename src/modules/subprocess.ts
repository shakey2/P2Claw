/**
 * P2 Claw — Core subprocess execution helpers.
 *
 * Centralises real child-process execution for broker shell/process primitives.
 * Policy is intentionally strict and minimal: bounded runtime, bounded output,
 * deterministic cwd, and a small allowlisted environment.
 */

import { spawn } from "child_process";

export const DEFAULT_SUBPROCESS_TIMEOUT_MS = 10_000;
export const MAX_SUBPROCESS_TIMEOUT_MS = 60_000;
export const DEFAULT_SUBPROCESS_OUTPUT_CAP_BYTES = 64 * 1024;
export const SUBPROCESS_CWD_MODE = "repo_root";

export interface SubprocessPolicy {
  timeoutMs?: number;
  stdoutCapBytes?: number;
  stderrCapBytes?: number;
}

export interface SubprocessResult {
  stdout: string;
  stderr: string;
  code: number;
  signal?: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

const ENV_ALLOWLIST = [
  "SystemRoot",
  "ComSpec",
  "WINDIR",
  "PATH",
  "PATHEXT",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
] as const;

function clampMs(ms: number | undefined): number {
  const raw = Number.isFinite(ms) ? Math.floor(ms as number) : DEFAULT_SUBPROCESS_TIMEOUT_MS;
  if (raw < 1) return 1;
  if (raw > MAX_SUBPROCESS_TIMEOUT_MS) return MAX_SUBPROCESS_TIMEOUT_MS;
  return raw;
}

function clampCap(bytes: number | undefined): number {
  const raw = Number.isFinite(bytes)
    ? Math.floor(bytes as number)
    : DEFAULT_SUBPROCESS_OUTPUT_CAP_BYTES;
  if (raw < 1024) return 1024;
  if (raw > 1024 * 1024) return 1024 * 1024;
  return raw;
}

function buildAllowedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  return env;
}

function captureChunk(
  current: string,
  chunk: Buffer,
  capBytes: number
): { next: string; truncated: boolean } {
  const used = Buffer.byteLength(current, "utf8");
  if (used >= capBytes) {
    return { next: current, truncated: true };
  }
  const remaining = capBytes - used;
  if (chunk.byteLength <= remaining) {
    return {
      next: current + chunk.toString("utf8"),
      truncated: false,
    };
  }
  return {
    next: current + chunk.subarray(0, remaining).toString("utf8"),
    truncated: true,
  };
}

function toResultFromSpawnError(
  message: string,
  timeout: boolean,
  signal?: string
): SubprocessResult {
  return {
    stdout: "",
    stderr: message,
    code: -1,
    signal,
    timedOut: timeout,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function executeRaw(
  bin: string,
  argv: readonly string[],
  policy?: SubprocessPolicy,
  execution?: { shell: string | false }
): Promise<SubprocessResult> {
  const timeoutMs = clampMs(policy?.timeoutMs);
  const stdoutCap = clampCap(policy?.stdoutCapBytes);
  const stderrCap = clampCap(policy?.stderrCapBytes);

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let done = false;

    const child = spawn(bin, [...argv], {
      cwd: process.cwd(),
      env: buildAllowedEnv(),
      shell: execution?.shell ?? false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 1_000).unref();
    }, timeoutMs);
    killTimer.unref();

    child.stdout?.on("data", (chunk: Buffer) => {
      const captured = captureChunk(stdout, chunk, stdoutCap);
      stdout = captured.next;
      stdoutTruncated = stdoutTruncated || captured.truncated;
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const captured = captureChunk(stderr, chunk, stderrCap);
      stderr = captured.next;
      stderrTruncated = stderrTruncated || captured.truncated;
    });

    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      resolve(toResultFromSpawnError(`spawn failed: ${err.message}`, timedOut));
    });

    child.on("close", (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      resolve({
        stdout,
        stderr,
        code: typeof code === "number" ? code : -1,
        signal: signal ?? undefined,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

export async function runSpawn(
  command: string,
  args: readonly string[],
  policy?: SubprocessPolicy
): Promise<SubprocessResult> {
  const cmd = command.trim();
  if (cmd.length === 0) {
    return toResultFromSpawnError("spawn failed: command must be non-empty", false);
  }
  return executeRaw(cmd, args, policy, { shell: false });
}

export async function runShell(
  command: string,
  args: readonly string[],
  policy?: SubprocessPolicy
): Promise<SubprocessResult> {
  const cmd = command.trim();
  if (cmd.length === 0) {
    return toResultFromSpawnError("shell failed: command must be non-empty", false);
  }
  const shellCommand = /\s/.test(cmd) ? `"${cmd.replace(/"/g, '\\"')}"` : cmd;
  const shellBinary =
    process.platform === "win32"
      ? process.env.ComSpec?.trim() || "cmd.exe"
      : "/bin/sh";
  return executeRaw(shellCommand, args, policy, { shell: shellBinary });
}

function redactMaybeSensitive(value: string): string {
  const SENSITIVE =
    /(token|secret|password|api[_-]?key|credential|authorization|bearer|cookie|session)/i;
  if (SENSITIVE.test(value)) return "[REDACTED]";
  if (value.length > 64) return `${value.slice(0, 61)}...`;
  return value;
}

export function buildSubprocessApprovalSummary(
  primitive: "shell.execute" | "process.spawn",
  args: Record<string, unknown>,
  policy?: SubprocessPolicy
): string {
  const cmd =
    typeof args.cmd === "string"
      ? args.cmd
      : typeof args.command === "string"
        ? args.command
        : "(unknown)";
  const rawArgv = Array.isArray(args.args)
    ? args.args
    : Array.isArray(args.argv)
      ? args.argv
      : [];
  const argv = rawArgv.filter((v): v is string => typeof v === "string");
  const preview = argv
    .slice(0, 4)
    .map(redactMaybeSensitive)
    .join(" ");
  const timeoutMs = clampMs(policy?.timeoutMs);
  const stdoutCap = clampCap(policy?.stdoutCapBytes);
  const stderrCap = clampCap(policy?.stderrCapBytes);

  return (
    `${primitive} cmd=${redactMaybeSensitive(cmd)} argc=${argv.length}` +
    ` args=${preview || "(none)"}` +
    ` cwd=${SUBPROCESS_CWD_MODE}` +
    ` timeoutMs=${timeoutMs}` +
    ` stdoutCap=${stdoutCap}` +
    ` stderrCap=${stderrCap}`
  );
}
