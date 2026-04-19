/**
 * P2 Claw - Tool: file_read
 *
 * Safe-by-default file read inside the Core-managed workspace sandbox.
 */

import { existsSync, readFileSync, statSync } from "fs";
import type { ToolDefinition } from "./tool-types.js";
import { hashArgs, writeFsEvent } from "../modules/audit.js";
import {
  MAX_WORKSPACE_FILE_BYTES,
  checkWorkspaceSandbox,
  summarisePath,
} from "../modules/fs-policy.js";

const fileRead: ToolDefinition = {
  schema: {
    type: "function" as const,
    function: {
      name: "file_read",
      description:
        "Read a UTF-8 text file from the sandboxed workspace area (data/workspace).",
      parameters: {
        type: "object",
        properties: {
          rel_path: {
            type: "string",
            description: "Relative path inside data/workspace (for example notes/today.md).",
          },
        },
        required: ["rel_path"],
      },
    },
  },
  risk: "safe",
  handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
    const relPath = typeof rawArgs.rel_path === "string" ? rawArgs.rel_path : "";
    if (!relPath.trim()) {
      return JSON.stringify({ error: "rel_path is required." });
    }

    let absPath: string;
    try {
      absPath = checkWorkspaceSandbox(relPath);
    } catch (err) {
      writeFsEvent({
        kind: "fs_event",
        moduleId: "core",
        permission: "fs.read_public",
        operation: "read",
        pathHash: hashArgs(relPath),
        pathSummary: summarisePath(relPath),
        outcome: "denied_sandbox",
        banned: false,
      });
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `Sandbox denied: ${message}` });
    }

    if (!existsSync(absPath)) {
      writeFsEvent({
        kind: "fs_event",
        moduleId: "core",
        permission: "fs.read_public",
        operation: "read",
        pathHash: hashArgs(absPath),
        pathSummary: summarisePath(absPath),
        outcome: "not_found",
        banned: false,
      });
      return JSON.stringify({ error: `File not found: ${relPath}` });
    }

    const info = statSync(absPath);
    if (!info.isFile()) {
      writeFsEvent({
        kind: "fs_event",
        moduleId: "core",
        permission: "fs.read_public",
        operation: "read",
        pathHash: hashArgs(absPath),
        pathSummary: summarisePath(absPath),
        outcome: "denied_sandbox",
        banned: false,
      });
      return JSON.stringify({ error: `Not a regular file: ${relPath}` });
    }

    if (info.size > MAX_WORKSPACE_FILE_BYTES) {
      writeFsEvent({
        kind: "fs_event",
        moduleId: "core",
        permission: "fs.read_public",
        operation: "read",
        pathHash: hashArgs(absPath),
        pathSummary: summarisePath(absPath),
        outcome: "denied_sandbox",
        banned: false,
      });
      return JSON.stringify({
        error: `File exceeds ${MAX_WORKSPACE_FILE_BYTES} bytes.`,
      });
    }

    try {
      const content = readFileSync(absPath, "utf-8");
      writeFsEvent({
        kind: "fs_event",
        moduleId: "core",
        permission: "fs.read_public",
        operation: "read",
        pathHash: hashArgs(absPath),
        pathSummary: summarisePath(absPath),
        outcome: "success",
        bytesTransferred: Buffer.byteLength(content, "utf-8"),
        banned: false,
      });
      return JSON.stringify({
        ok: true,
        rel_path: relPath,
        bytes: Buffer.byteLength(content, "utf-8"),
        content,
      });
    } catch (err) {
      writeFsEvent({
        kind: "fs_event",
        moduleId: "core",
        permission: "fs.read_public",
        operation: "read",
        pathHash: hashArgs(absPath),
        pathSummary: summarisePath(absPath),
        outcome: "error",
        banned: false,
      });
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `Read failed: ${message}` });
    }
  },
};

export default fileRead;
