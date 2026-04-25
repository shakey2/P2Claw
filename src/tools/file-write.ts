/**
 * P2 Claw - Tool: file_write
 *
 * High-risk write operation inside the Core-managed workspace sandbox.
 */

import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { ToolDefinition } from "./tool-types.js";
import { hashArgs, writeFsEvent } from "../core/modules/audit.js";
import {
  MAX_WORKSPACE_FILE_BYTES,
  buildFsApprovalSummary,
  checkWorkspaceSandbox,
  checkWriteBan,
  summarisePath,
} from "../core/modules/fs-policy.js";

function isHardBanError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("fs: hard ban");
}

const fileWrite: ToolDefinition = {
  risk: "high",
  schema: {
    type: "function" as const,
    function: {
      name: "file_write",
      description:
        "Write UTF-8 text to a file inside the sandboxed workspace area (data/workspace). Overwrites existing files.",
      parameters: {
        type: "object",
        properties: {
          rel_path: {
            type: "string",
            description: "Relative path inside data/workspace (for example notes/today.md).",
          },
          content: {
            type: "string",
            description: "UTF-8 text content to write.",
          },
        },
        required: ["rel_path", "content"],
      },
    },
  },
  handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
    const relPath = typeof rawArgs.rel_path === "string" ? rawArgs.rel_path : "";
    if (!relPath.trim()) {
      return JSON.stringify({ error: "rel_path is required." });
    }
    if (typeof rawArgs.content !== "string") {
      return JSON.stringify({ error: "content must be a string." });
    }
    const content = rawArgs.content;
    const bytes = Buffer.byteLength(content, "utf-8");
    if (bytes > MAX_WORKSPACE_FILE_BYTES) {
      return JSON.stringify({
        error: `content exceeds ${MAX_WORKSPACE_FILE_BYTES} bytes.`,
      });
    }

    let absPath: string;
    try {
      absPath = checkWorkspaceSandbox(relPath);
    } catch (err) {
      writeFsEvent({
        kind: "fs_event",
        moduleId: "core",
        permission: "fs.write_any",
        operation: "write",
        pathHash: hashArgs(relPath),
        pathSummary: summarisePath(relPath),
        outcome: "denied_sandbox",
        banned: false,
      });
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `Sandbox denied: ${message}` });
    }

    try {
      checkWriteBan(absPath);
    } catch (err) {
      const hardBan = isHardBanError(err);
      writeFsEvent({
        kind: "fs_event",
        moduleId: "core",
        permission: "fs.write_any",
        operation: "write",
        pathHash: hashArgs(absPath),
        pathSummary: summarisePath(absPath),
        outcome: hardBan ? "denied_ban" : "error",
        banned: hardBan,
      });
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: message });
    }

    try {
      // Workspace is created lazily on first write.
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, content, "utf-8");
      writeFsEvent({
        kind: "fs_event",
        moduleId: "core",
        permission: "fs.write_any",
        operation: "write",
        pathHash: hashArgs(absPath),
        pathSummary: summarisePath(absPath),
        outcome: "success",
        bytesTransferred: bytes,
        banned: false,
      });
      return JSON.stringify({
        ok: true,
        rel_path: relPath,
        bytes,
        approval_summary: buildFsApprovalSummary("write", absPath, bytes),
      });
    } catch (err) {
      writeFsEvent({
        kind: "fs_event",
        moduleId: "core",
        permission: "fs.write_any",
        operation: "write",
        pathHash: hashArgs(absPath),
        pathSummary: summarisePath(absPath),
        outcome: "error",
        banned: false,
      });
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `Write failed: ${message}` });
    }
  },
};

export default fileWrite;
