/**
 * P2 Claw — Tool: get_current_time
 *
 * Returns the current date and time. The first and simplest tool
 * to validate the agentic loop is working correctly.
 */

import type { ToolDefinition } from "./registry.js";

interface GetCurrentTimeArgs {
  timezone?: string;
}

const getCurrentTime: ToolDefinition = {
  schema: {
    type: "function" as const,
    function: {
      name: "get_current_time",
      description:
        "Returns the current date and time. Use this when the user asks about the current time, date, day of the week, or anything time-related.",
      parameters: {
        type: "object",
        properties: {
          timezone: {
            type: "string",
            description:
              'IANA timezone name (e.g. "America/New_York", "Europe/London", "Asia/Tokyo"). Defaults to the system timezone if not specified.',
          },
        },
        required: [],
      },
    },
  },

  handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
    const args = rawArgs as GetCurrentTimeArgs;
    const now = new Date();

    try {
      const options: Intl.DateTimeFormatOptions = {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
        timeZoneName: "long",
      };

      if (args.timezone) {
        options.timeZone = args.timezone;
      }

      const formatted = new Intl.DateTimeFormat("en-US", options).format(now);
      const iso = now.toISOString();

      return JSON.stringify({
        formatted,
        iso,
        timezone: args.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        unix: Math.floor(now.getTime() / 1000),
      });
    } catch (err) {
      return JSON.stringify({
        error: `Invalid timezone "${args.timezone}". Use IANA format like "America/New_York".`,
        fallback_utc: now.toISOString(),
      });
    }
  },
};

export default getCurrentTime;
