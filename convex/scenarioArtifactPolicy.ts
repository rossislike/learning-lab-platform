export const HOSTED_ENVIRONMENTS = ["local", "dev"] as const;
export type HostedEnvironment = (typeof HOSTED_ENVIRONMENTS)[number];

export type ScenarioRuntimeContract = {
  kind: "terminal" | "react";
  ttlSeconds: number;
  workspace: { cwd: string; user: "learner" | "root" };
  tabs: Array<"terminal" | "editor" | "preview">;
  setup?: string;
  stepCount: number;
  react?: {
    previewPort: number;
    installCommand: string;
    devCommand: string;
    testCommand: string;
  };
};

const digestPattern = /^[0-9a-f]{64}$/;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function configuredHostedEnvironment(
  value = process.env.HOSTED_ENVIRONMENT
): HostedEnvironment {
  // Unset means local (kind): bundles are mounted from the repository and no
  // approval record is required. "dev" requires an approved S3 bundle.
  if (value === undefined || value === "" || value === "local") return "local";
  if (value === "dev") return "dev";
  throw new Error("HOSTED_ENVIRONMENT must be local or dev");
}

export function assertScenarioArtifactApproval(input: {
  artifactKey: string;
  artifactSha256: string;
  artifactSizeBytes: number;
  environment: HostedEnvironment;
  manifestKey: string;
  manifestSha256: string;
  slug: string;
  sourceManifestSha256: string;
  runtime: ScenarioRuntimeContract;
  schemaVersion: number;
}) {
  if (!slugPattern.test(input.slug)) throw new Error("Invalid scenario slug");
  for (const [name, digest] of [
    ["artifactSha256", input.artifactSha256],
    ["manifestSha256", input.manifestSha256],
    ["sourceManifestSha256", input.sourceManifestSha256],
  ] as const) {
    if (!digestPattern.test(digest)) throw new Error(`Invalid ${name}`);
  }
  if (
    !Number.isSafeInteger(input.artifactSizeBytes) ||
    input.artifactSizeBytes < 1 ||
    input.artifactSizeBytes > 64 * 1024 * 1024
  ) {
    throw new Error("Invalid artifactSizeBytes");
  }
  const expectedArtifactKey = `scenarios/${input.slug}/bundles/sha256/${input.artifactSha256}.tar`;
  const expectedManifestKey = `scenarios/${input.slug}/manifests/sha256/${input.manifestSha256}.json`;
  if (input.artifactKey !== expectedArtifactKey) {
    throw new Error("Artifact key does not match its approved digest");
  }
  if (input.manifestKey !== expectedManifestKey) {
    throw new Error("Manifest key does not match its approved digest");
  }
  if (input.schemaVersion !== 2) throw new Error("Invalid schemaVersion");
  assertScenarioRuntimeContract(input.slug, input.runtime);
}

const scriptPattern = /^scripts\/[a-z0-9-]+\.sh$/;
const commandPattern = /^\S.*\S$|^\S$/;

export function assertScenarioRuntimeContract(
  slug: string,
  runtime: ScenarioRuntimeContract
) {
  void slug;
  if (!runtime || typeof runtime !== "object") {
    throw new Error("Invalid runtime contract");
  }
  if (runtime.kind !== "terminal" && runtime.kind !== "react") {
    throw new Error("Invalid runtime.kind");
  }
  if (
    !Number.isSafeInteger(runtime.ttlSeconds) ||
    runtime.ttlSeconds < 60 ||
    runtime.ttlSeconds > 8 * 60 * 60
  ) {
    throw new Error("Invalid runtime.ttlSeconds");
  }
  if (
    !runtime.workspace ||
    typeof runtime.workspace.cwd !== "string" ||
    !/^\/[^\s]*$/.test(runtime.workspace.cwd) ||
    runtime.workspace.cwd.split("/").includes("..") ||
    (runtime.workspace.user !== "learner" && runtime.workspace.user !== "root")
  ) {
    throw new Error("Invalid runtime.workspace");
  }
  if (
    !Array.isArray(runtime.tabs) ||
    runtime.tabs.length === 0 ||
    runtime.tabs.length > 3 ||
    new Set(runtime.tabs).size !== runtime.tabs.length ||
    runtime.tabs.some((tab) => !["terminal", "editor", "preview"].includes(tab))
  ) {
    throw new Error("Invalid runtime.tabs");
  }
  if (runtime.setup !== undefined && !scriptPattern.test(runtime.setup)) {
    throw new Error("Invalid runtime.setup");
  }
  if (
    !Number.isSafeInteger(runtime.stepCount) ||
    runtime.stepCount < 0 ||
    runtime.stepCount > 30
  ) {
    throw new Error("Invalid runtime.stepCount");
  }
  if (runtime.kind === "react") {
    const react = runtime.react;
    if (
      !react ||
      !Number.isSafeInteger(react.previewPort) ||
      react.previewPort < 1024 ||
      react.previewPort > 65535
    ) {
      throw new Error("Invalid runtime.react");
    }
    for (const name of ["installCommand", "devCommand", "testCommand"] as const) {
      const value = react[name];
      if (typeof value !== "string" || !commandPattern.test(value)) {
        throw new Error(`Invalid runtime.react.${name}`);
      }
    }
  } else if (runtime.react !== undefined) {
    throw new Error("Terminal scenarios cannot define runtime.react");
  }
}

export function planScenarioArtifactApproval<Id>(
  activeApprovals: Array<{
    _id: Id;
    artifactSha256: string;
    manifestSha256: string;
  }>,
  next: { artifactSha256: string; manifestSha256: string }
) {
  const unchanged = activeApprovals.find(
    (approval) =>
      approval.artifactSha256 === next.artifactSha256 &&
      approval.manifestSha256 === next.manifestSha256
  );
  return {
    unchangedId:
      unchanged && activeApprovals.length === 1 ? unchanged._id : undefined,
    supersedeIds: activeApprovals.map((approval) => approval._id),
  };
}
