/**
 * P2 Claw — Demo module: demo-safe (first-party).
 *
 * Exercises the module framework end-to-end using only safe permissions.
 *
 *   - demo_ping   : returns current wall-clock time via the broker.
 *   - demo_notes  : round-trips a note through module-scoped memory and
 *                   (if present) appends the contents of
 *                   data/public/com.p2claw.demo-safe/intro.md.
 */

import type { Module, ModuleContext, ModuleTool } from "../../modules/types.js";
import { PermissionDeniedError } from "../../modules/types.js";

interface PingArgs {
  note?: string;
}

interface NotesArgs {
  key?: unknown;
  value?: unknown;
}

function makeDemoPing(ctx: ModuleContext): ModuleTool {
  return {
    schema: {
      type: "function",
      function: {
        name: "demo_ping",
        description:
          "Ping the demo-safe module and get the current time back. Proves the module framework is wired.",
        parameters: {
          type: "object",
          properties: {
            note: {
              type: "string",
              description: "Optional note to include in the reply.",
            },
          },
          required: [],
        },
      },
    },
    requires: ["log.info", "time.now"],
    handler: async (rawArgs): Promise<string> => {
      const args = rawArgs as PingArgs;
      const note = typeof args.note === "string" ? args.note : "";

      await ctx.log.info(`demo_ping invoked (note="${note}")`);
      const now = await ctx.time.now();

      return JSON.stringify({
        module: ctx.moduleId,
        now: now.toISOString(),
        note,
        ok: true,
      });
    },
  };
}

function makeDemoNotes(ctx: ModuleContext): ModuleTool {
  return {
    schema: {
      type: "function",
      function: {
        name: "demo_notes",
        description:
          "Reads or writes a module-scoped note by key. If 'value' is provided, writes it.",
        parameters: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "The note key to read or write.",
            },
            value: {
              type: "string",
              description:
                "If provided, the value to store under 'key'. Omit to read only.",
            },
          },
          required: ["key"],
        },
      },
    },
    requires: ["memory.read", "memory.write", "fs.read_public"],
    handler: async (rawArgs): Promise<string> => {
      const args = rawArgs as NotesArgs;
      const key = typeof args.key === "string" ? args.key : "";
      if (!key) {
        return JSON.stringify({ error: "key is required" });
      }

      if (typeof args.value === "string") {
        await ctx.memory.write(key, args.value);
      }
      const stored = await ctx.memory.read(key);

      // intro.md is optional — treat any broker denial as "no intro".
      let intro: string | null = null;
      try {
        intro = await ctx.fs.readPublic("intro.md");
      } catch (err) {
        if (!(err instanceof PermissionDeniedError)) throw err;
      }

      return JSON.stringify({
        module: ctx.moduleId,
        key,
        value: stored,
        intro,
        ok: true,
      });
    },
  };
}

const mod: Module = {
  register({ ctx, contributeTool }) {
    contributeTool(makeDemoPing(ctx));
    contributeTool(makeDemoNotes(ctx));
  },
};

export default mod;
