import type {
  HostedEnvironment,
  ScenarioRuntimeContract,
} from "./scenarioArtifactPolicy";

type HostedApproval<LabId, ApprovalId> = {
  _id: ApprovalId;
  labId: LabId;
  slug: string;
  environment: "dev";
  artifactSha256: string;
  artifactKey: string;
  artifactSizeBytes: number;
  manifestSha256: string;
  manifestKey: string;
  sourceManifestSha256: string;
  runtime: ScenarioRuntimeContract;
  schemaVersion: number;
};

/**
 * In the local environment (kind) bundles are mounted from the repository
 * and sessions carry no approval snapshot. In dev every session pins the
 * approved, digest-addressed bundle for its scenario.
 */
export async function resolveScenarioSessionSnapshot<LabId, ApprovalId>({
  labId,
  configuredEnvironment,
  validateApproval,
  loadLab,
  loadApproval,
}: {
  labId: LabId;
  configuredEnvironment: () => HostedEnvironment;
  validateApproval: (approval: HostedApproval<LabId, ApprovalId>) => void;
  loadLab: () => Promise<{ _id: LabId; slug: string; status: string } | null>;
  loadApproval: (environment: "dev") => Promise<HostedApproval<LabId, ApprovalId> | null>;
}) {
  const environment = configuredEnvironment();
  if (environment === "local") return undefined;
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
      workspace: { ...approval.runtime.workspace },
      tabs: [...approval.runtime.tabs],
      ...(approval.runtime.react ? { react: { ...approval.runtime.react } } : {}),
    },
    schemaVersion: approval.schemaVersion,
  };
}
