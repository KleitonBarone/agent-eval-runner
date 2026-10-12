import { Type, type Static } from "@sinclair/typebox";

export const ExecutionConfigSchema = Type.Union([
  Type.Object({ kind: Type.Literal("local") }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal("docker"),
      image: Type.String({
        pattern: "^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[0-9a-f]{64}$",
      }),
    },
    { additionalProperties: false },
  ),
]);

export type ExecutionConfig = Static<typeof ExecutionConfigSchema>;

export const CONTAINER_POLICY = {
  network: "none",
  readOnlyRoot: true,
  capabilities: "none",
  noNewPrivileges: true,
  memoryBytes: 512 * 1024 * 1024,
  cpus: 1,
  pids: 128,
  temporaryBytes: 64 * 1024 * 1024,
  temporaryInodes: 4096,
  workspaceStorage: "local_tmpfs_volume",
  workspaceBytes: 128 * 1024 * 1024,
  workspaceInodes: 12000,
  storageLifecycle: "read_only_holder",
  sourceMetadata: false,
  hostCredentials: false,
  dockerSocket: false,
  commandLifecycle: "restart_per_command",
} as const;

const NullableString = Type.Union([Type.String(), Type.Null()]);
const NullableId = Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]);

export const ExecutionEvidenceSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("local"),
      policyVersion: Type.Literal("trusted-worktree-v1"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("docker"),
      policyVersion: Type.Literal("linux-container-v2"),
      requestedImage: Type.String(),
      imageId: NullableString,
      architecture: NullableString,
      node: NullableString,
      engineVersion: NullableString,
      uid: NullableId,
      gid: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
      containerId: NullableString,
      containerName: NullableString,
      cleanup: Type.Union([
        Type.Literal("not_created"),
        Type.Literal("pending"),
        Type.Literal("removed"),
        Type.Literal("failed"),
      ]),
      workspacePath: NullableString,
      storage: Type.Object(
        {
          volumeName: NullableString,
          holderName: NullableString,
          holderId: NullableString,
          verified: Type.Boolean(),
          cleanup: Type.Union([
            Type.Literal("not_created"),
            Type.Literal("pending"),
            Type.Literal("removed"),
            Type.Literal("retained"),
            Type.Literal("failed"),
          ]),
        },
        { additionalProperties: false },
      ),
      policy: Type.Object(
        {
          network: Type.Literal(CONTAINER_POLICY.network),
          readOnlyRoot: Type.Literal(CONTAINER_POLICY.readOnlyRoot),
          capabilities: Type.Literal(CONTAINER_POLICY.capabilities),
          noNewPrivileges: Type.Literal(CONTAINER_POLICY.noNewPrivileges),
          memoryBytes: Type.Literal(CONTAINER_POLICY.memoryBytes),
          cpus: Type.Literal(CONTAINER_POLICY.cpus),
          pids: Type.Literal(CONTAINER_POLICY.pids),
          temporaryBytes: Type.Literal(CONTAINER_POLICY.temporaryBytes),
          temporaryInodes: Type.Literal(CONTAINER_POLICY.temporaryInodes),
          workspaceStorage: Type.Literal(CONTAINER_POLICY.workspaceStorage),
          workspaceBytes: Type.Literal(CONTAINER_POLICY.workspaceBytes),
          workspaceInodes: Type.Literal(CONTAINER_POLICY.workspaceInodes),
          storageLifecycle: Type.Literal(CONTAINER_POLICY.storageLifecycle),
          sourceMetadata: Type.Literal(CONTAINER_POLICY.sourceMetadata),
          hostCredentials: Type.Literal(CONTAINER_POLICY.hostCredentials),
          dockerSocket: Type.Literal(CONTAINER_POLICY.dockerSocket),
          commandLifecycle: Type.Literal(CONTAINER_POLICY.commandLifecycle),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
]);

export type ExecutionEvidence = Static<typeof ExecutionEvidenceSchema>;

export function executionIdentity(config: ExecutionConfig | undefined) {
  return config?.kind === "docker"
    ? {
        ...config,
        policyVersion: "linux-container-v2",
        policy: CONTAINER_POLICY,
      }
    : { kind: "local", policyVersion: "trusted-worktree-v1" };
}

export function initialExecutionEvidence(
  config: ExecutionConfig | undefined,
): ExecutionEvidence {
  if (config?.kind !== "docker")
    return { kind: "local", policyVersion: "trusted-worktree-v1" };
  return {
    kind: "docker",
    policyVersion: "linux-container-v2",
    requestedImage: config.image,
    imageId: null,
    architecture: null,
    node: null,
    engineVersion: null,
    uid: null,
    gid: null,
    containerId: null,
    containerName: null,
    cleanup: "not_created",
    workspacePath: null,
    storage: {
      volumeName: null,
      holderName: null,
      holderId: null,
      verified: false,
      cleanup: "not_created",
    },
    policy: { ...CONTAINER_POLICY },
  };
}
