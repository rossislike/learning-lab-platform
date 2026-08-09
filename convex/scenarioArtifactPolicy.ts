export const HOSTED_ENVIRONMENTS = ["staging", "production"] as const;
export type HostedEnvironment = (typeof HOSTED_ENVIRONMENTS)[number];

export type ScenarioRuntimeContract = {
  expectedBehavior: string;
  expectedPorts: Array<{
    name: string;
    containerPort: number;
    public: boolean;
  }>;
  packagedWorkspaceTemplatePath: string;
  previewCommand: string;
  remediationFile: string;
  ttlSeconds: number;
  validationCommand: string;
};

const digestPattern = /^[0-9a-f]{64}$/;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function configuredHostedEnvironment(
  value = process.env.HOSTED_ENVIRONMENT
): HostedEnvironment {
  if (value !== "staging" && value !== "production") {
    throw new Error(
      "HOSTED_ENVIRONMENT must be staging or production for hosted sessions"
    );
  }
  return value;
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
  const expectedArtifactKey = `scenarios/${input.slug}/artifacts/sha256/${input.artifactSha256}.tar`;
  const expectedManifestKey = `scenarios/${input.slug}/manifests/sha256/${input.manifestSha256}.json`;
  if (input.artifactKey !== expectedArtifactKey) {
    throw new Error("Artifact key does not match its approved digest");
  }
  if (input.manifestKey !== expectedManifestKey) {
    throw new Error("Manifest key does not match its approved digest");
  }
  if (input.schemaVersion !== 1) throw new Error("Invalid schemaVersion");
  assertScenarioRuntimeContract(input.slug, input.runtime);
}

export function assertScenarioRuntimeContract(
  slug: string,
  runtime: ScenarioRuntimeContract
) {
  if (!runtime || typeof runtime !== "object") {
    throw new Error("Invalid runtime contract");
  }
  for (const name of [
    "expectedBehavior",
    "packagedWorkspaceTemplatePath",
    "previewCommand",
    "remediationFile",
    "validationCommand",
  ] as const) {
    const value = runtime?.[name];
    if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
      throw new Error(`Invalid runtime.${name}`);
    }
  }
  const expectedTemplatePrefix = `lab-definitions/${slug}/`;
  if (
    !runtime.packagedWorkspaceTemplatePath.startsWith(expectedTemplatePrefix) ||
    runtime.packagedWorkspaceTemplatePath.includes("\\") ||
    runtime.packagedWorkspaceTemplatePath.split("/").includes("..")
  ) {
    throw new Error("Invalid runtime.packagedWorkspaceTemplatePath");
  }
  if (
    !Number.isSafeInteger(runtime.ttlSeconds) ||
    runtime.ttlSeconds < 1 ||
    runtime.ttlSeconds > 8 * 60 * 60
  ) {
    throw new Error("Invalid runtime.ttlSeconds");
  }
  if (!Array.isArray(runtime.expectedPorts) || runtime.expectedPorts.length > 16) {
    throw new Error("Invalid runtime.expectedPorts");
  }
  const names = new Set<string>();
  for (const port of runtime.expectedPorts) {
    if (
      typeof port?.name !== "string" ||
      !/^[a-z][a-z0-9-]{0,31}$/.test(port.name) ||
      names.has(port.name) ||
      !Number.isSafeInteger(port.containerPort) ||
      port.containerPort < 1 ||
      port.containerPort > 65535 ||
      typeof port.public !== "boolean"
    ) {
      throw new Error("Invalid runtime.expectedPorts");
    }
    names.add(port.name);
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
