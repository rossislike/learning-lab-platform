import type {
  HostedEnvironment,
  ScenarioRuntimeContract,
} from "./scenarioArtifactPolicy";

type HostedApproval<LabId, ApprovalId> = {
  _id: ApprovalId;
  labId: LabId;
  slug: string;
  environment: HostedEnvironment;
  artifactSha256: string;
  artifactKey: string;
  artifactSizeBytes: number;
  manifestSha256: string;
  manifestKey: string;
  sourceManifestSha256: string;
  runtime: ScenarioRuntimeContract;
  schemaVersion: number;
};

export async function resolveScenarioSessionSnapshot<LabId, ApprovalId>({
  runner,
  labId,
  configuredEnvironment,
  validateApproval,
  loadLab,
  loadApproval,
}: {
  runner: "local" | "kubernetes";
  labId: LabId;
  configuredEnvironment: () => HostedEnvironment;
  validateApproval: (approval: HostedApproval<LabId, ApprovalId>) => void;
  loadLab: () => Promise<{ _id: LabId; slug: string; status: string } | null>;
  loadApproval: (
    environment: HostedEnvironment
  ) => Promise<HostedApproval<LabId, ApprovalId> | null>;
}) {
  if (runner === "local") return undefined;

  const environment = configuredEnvironment();
  const lab = await loadLab();
  if (!lab || lab.status !== "active") {
    throw new Error("Hosted sessions require an active scenario");
  }
  const approval = await loadApproval(environment);
  if (!approval) {
    throw new Error(
      "Hosted scenario artifact is not approved for this environment"
    );
  }
  if (
    approval.environment !== environment ||
    approval.labId !== labId ||
    approval.slug !== lab.slug
  ) {
    throw new Error("Hosted scenario approval does not match the requested lab");
  }
  validateApproval(approval);

  return {
    approvalId: approval._id,
    environment: approval.environment,
    slug: approval.slug,
    artifactSha256: approval.artifactSha256,
    artifactKey: approval.artifactKey,
    artifactSizeBytes: approval.artifactSizeBytes,
    manifestSha256: approval.manifestSha256,
    manifestKey: approval.manifestKey,
    sourceManifestSha256: approval.sourceManifestSha256,
    runtime: {
      ...approval.runtime,
      expectedPorts: approval.runtime.expectedPorts.map((port) => ({ ...port })),
    },
    schemaVersion: approval.schemaVersion,
  };
}
