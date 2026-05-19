export type RunnerMode = "local" | "aws-ecs-fargate";

export type StartSessionInput = {
  sessionId: string;
  labSlug: string;
  workspaceTemplatePath: string;
  ttlSeconds: number;
};

export type RunningSession = {
  workspaceUrl: string;
  previewUrl: string;
  terminalUrl: string;
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
