/**
 * P2 Claw - Tool: file_list
 *
 * Safe directory listing inside the Core-managed workspace sandbox.
 */

import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type { ToolDefinition } from "./tool-types.js";
import { hashArgs, writeFsEvent } from "../core/modules/audit.js";
import { checkWorkspaceSandbox, summarisePath } from "../core/modules/fs-policy.js";

interface FileListEntry {
  name: string;
  type: "file" | "dir" | "other";
  size?: number;
}

const fileList: ToolDefinition = {
  schema: {
    type: "function" as const,
    function: {
      name: "file_list",
      description:
        "List files and directories under the sandboxed workspace area (data/workspace).",
      parameters: {
        type: "object",
        properties: {
          rel_path: {
            type: "string",
            description:
              'Relative directory path inside data/workspace. Defaults to "." when omitted.',
          },
        },
        required: [],
      },
    },
  },
  risk: "safe",
  handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
    const relPath = typeof rawArgs.rel_path === "string" ? rawArgs.rel_path : ".";
    let absPath: string;
    try {
      absPath = checkWorkspaceSandbox(relPath);
    } catch (err) {
      writeFsEvent({
        kind: "fs_event",
        moduleId: "core",
        permission: "fs.read_public",
        operation: "list",
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
        operation: "list",
        pathHash: hashArgs(absPath),
        pathSummary: summarisePath(absPath),
        outcome: "not_found",
        banned: false,
      });
      return JSON.stringify({ error: `Directory not found: ${relPath}` });
    }

    const info = statSync(absPath);
    if (!info.isDirectory()) {
      writeFsEvent({
        kind: "fs_event",
        moduleId: "core",
        permission: "fs.read_public",
        operation: "list",
        pathHash: hashArgs(absPath),
        pathSummary: summarisePath(absPath),
        outcome: "denied_sandbox",
        banned: false,
      });
      return JSON.stringify({ error: `Not a directory: ${relPath}` });
    }

    try {
      const entries = readdirSync(absPath);
      const out: FileListEntry[] = entries.map((name) => {
        const p = join(absPath, name);
        const st = statSync(p);
        if (st.isDirectory()) {
          return { name, type: "dir" as const };
        }
        if (st.isFile()) {
          return { name, type: "file" as const, size: st.size };
        }
        return { name, type: "other" as const };
      });
      writeFsEvent({
        kind: "fs_event",
        moduleId: "core",
        permission: "fs.read_public",
        operation: "list",
        pathHash: hashArgs(absPath),
        pathSummary: summarisePath(absPath),
        outcome: "success",
        bytesTransferred: out.length,
        banned: false,
      });
      return JSON.stringify({
        ok: true,
        rel_path: relPath,
        entries: out,
      });
    } catch (err) {
      writeFsEvent({
        kind: "fs_event",
        moduleId: "core",
        permission: "fs.read_public",
        operation: "list",
        pathHash: hashArgs(absPath),
        pathSummary: summarisePath(absPath),
        outcome: "error",
        banned: false,
      });
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `List failed: ${message}` });
    }
  },
};

export default fileList;
