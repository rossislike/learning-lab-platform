import { query } from "./_generated/server";

export const sessionSummary = query({
  args: {},
  handler: async (ctx) => {
    const sessions = await ctx.db.query("sessions").order("desc").take(100);
    const startupDurations = sessions
      .map((session) => session.startupDurationMs)
      .filter(isNumber);
    const validationDurations = sessions
      .map((session) => session.lastValidationDurationMs)
      .filter(isNumber);
    const cleanupDurations = sessions
      .map((session) => session.cleanupDurationMs)
      .filter(isNumber);
    const terminalSessions = sessions.filter((session) =>
      ["passed", "failed", "errored", "expired", "stopped"].includes(session.status)
    );
    const failureCount = sessions.filter((session) =>
      ["failed", "errored"].includes(session.status)
    ).length;

    return {
      sampleSize: sessions.length,
      averageStartupMs: average(startupDurations),
      averageValidationMs: average(validationDurations),
      averageCleanupMs: average(cleanupDurations),
      failureCount,
      failureRate:
        terminalSessions.length > 0 ? failureCount / terminalSessions.length : 0,
      terminalSessionCount: terminalSessions.length,
    };
  },
});

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function average(values: number[]) {
  if (values.length === 0) {
    return undefined;
  }

  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}
