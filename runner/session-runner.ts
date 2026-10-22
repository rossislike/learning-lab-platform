export type RunnerMode = "local" | "kubernetes";

export type StartSessionInput = {
  sessionId: string;
  labSlug: string;
  workspaceTemplatePath: string;
  ttlSeconds: number;
  expiresAt?: number;
  convexUrl?: string;
};

export type RunningSession = {
  resourceId?: string;
  workspaceUrl?: string;
  previewUrl?: string;
  terminalUrl?: string;
};

export type CheckResult = {
  passed: boolean;
  score: number;
  summary: string;
  raw?: unknown;
};

export interface SessionRunner {
  start(input: StartSessionInput): Promise<RunningSession>;
  check(sessionId: string, command: string): Promise<CheckResult>;
  stop(sessionId: string): Promise<void>;
}
