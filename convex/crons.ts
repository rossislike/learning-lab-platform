import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// Phase 6 TTL safety net (see sessions.sweep). The dispatcher is the primary
// expirer; this catches the cases where it is down or wedged.
const crons = cronJobs();
crons.interval("sweep expired and stuck sessions", { minutes: 5 }, internal.sessions.sweep, {});
export default crons;
