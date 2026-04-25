/**
 * P2 Claw — Demo module: demo-high-risk (first-party).
 *
 * Declares the high-risk `shell.execute` permission so that invoking
 * `demo_shell` exercises the TOTP approval pipeline end-to-end. The broker's
 * shell primitive now runs a real subprocess with strict Core guardrails.
 */

import type { Module, ModuleContext, ModuleTool } from "../../core/modules/types.js";

interface ShellArgs {
  cmd?: unknown;
  args?: unknown;
}

function makeDemoShell(ctx: ModuleContext): ModuleTool {
  return {
    schema: {
      type: "function",
      function: {
        name: "demo_shell",
        description:
          "Run a shell command through Core's high-risk approval + audit pipeline.",
        parameters: {
          type: "object",
          properties: {
            cmd: {
              type: "string",
              description: "The command name to execute.",
            },
            args: {
              type: "array",
              items: { type: "string" },
              description: "Arguments to pass to the demo command.",
            },
          },
          required: ["cmd"],
        },
      },
    },
    requires: ["shell.execute", "log.info"],
    handler: async (rawArgs): Promise<string> => {
      const args = rawArgs as ShellArgs;
      const cmd = typeof args.cmd === "string" ? args.cmd : "";
      const cmdArgs = Array.isArray(args.args)
        ? args.args.filter((v): v is string => typeof v === "string")
        : [];

      if (!cmd) {
        return JSON.stringify({ error: "cmd is required" });
      }

      await ctx.log.info(`demo_shell invoked (cmd="${cmd}")`);
      const result = await ctx.shell.execute(cmd, cmdArgs);

      return JSON.stringify({
        module: ctx.moduleId,
        ...result,
      });
    },
  };
}

const mod: Module = {
  register({ ctx, contributeTool }) {
    contributeTool(makeDemoShell(ctx));
  },
};

export default mod;
