export function formatCountdown(ms: number) {
  if (ms <= 0) return "0m";
  const totalMinutes = Math.ceil(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes.toString().padStart(2, "0")}m` : `${minutes}m`;
}

export function difficultyLabel(level?: string | number) {
  if (typeof level === "string") return level;
  return level === 3 ? "hard" : level === 2 ? "medium" : "easy";
}

export { ACTIVE_STATUSES, USABLE_STATUSES } from "./sessionState";
