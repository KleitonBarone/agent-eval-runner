import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  CONTAINER_POLICY,
  PREPARATION_CONTAINER_POLICY,
} from "./execution-spec.js";

const MiB = 1024 * 1024;
const Count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$",
});
const Digest = Type.String({ pattern: "^[0-9a-f]{64}$" });
const NullableString = Type.Union([
  Type.String({ maxLength: 4096 }),
  Type.Null(),
]);

export const RESOURCE_POLICY = {
  version: "resource-admission-v1",
  metadataBytes: 20 * MiB,
  metadataEntries: 32,
  ledgerBytes: 8 * MiB,
  resultBytes: 128 * MiB,
  taskBytes: MiB,
  taskItems: 1000,
  poolBytes: 768 * MiB,
  poolEntries: 60000,
  dockerVolumeBytes:
    CONTAINER_POLICY.workspaceBytes +
    PREPARATION_CONTAINER_POLICY.workspaceBytes,
  dockerContainers: 4,
  dockerVolumes: 2,
} as const;

export const RESOURCE_RESERVATION = {
  poolBytes: RESOURCE_POLICY.poolBytes,
  poolEntries: RESOURCE_POLICY.poolEntries,
  dockerVolumeBytes: RESOURCE_POLICY.dockerVolumeBytes,
  dockerContainers: RESOURCE_POLICY.dockerContainers,
  dockerVolumes: RESOURCE_POLICY.dockerVolumes,
  records: 1,
} as const;
const ReservationSchema = Type.Const(RESOURCE_RESERVATION, {
  additionalProperties: false,
});

export const ResourceLimitsSchema = Type.Object(
  {
    poolBytes: Count,
    poolEntries: Count,
    dockerVolumeBytes: Count,
    dockerContainers: Count,
    dockerVolumes: Count,
    records: Type.Integer({ minimum: 1, maximum: 1000 }),
  },
  { additionalProperties: false },
);
export const ResourcePolicyInputSchema = Type.Object(
  {
    schemaVersion: Type.Literal("1"),
    limits: ResourceLimitsSchema,
  },
  {
    $id: "https://agent-eval-runner.dev/schemas/resource-policy-v1.schema.json",
    additionalProperties: false,
  },
);
export const ResourceCapacitySchema = Type.Object(
  {
    poolBytes: Count,
    poolEntries: Count,
    dockerVolumeBytes: Count,
    dockerContainers: Count,
    dockerVolumes: Count,
    records: Count,
  },
  { additionalProperties: false },
);

const ManagedIdentityFields = {
  kind: Type.Literal("managed"),
  policyVersion: Type.Literal(RESOURCE_POLICY.version),
  limits: ResourceLimitsSchema,
};
export const ResourceIdentitySchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("unmanaged") },
    { additionalProperties: false },
  ),
  Type.Object(ManagedIdentityFields, { additionalProperties: false }),
]);
export const ResourceAccountingSchema = Type.Union([
  ResourceIdentitySchema.anyOf[0],
  Type.Object(
    {
      ...ManagedIdentityFields,
      poolId: Uuid,
      reservationId: Uuid,
      reserved: ReservationSchema,
      resultBytesLimit: Type.Literal(RESOURCE_POLICY.resultBytes),
      resultPath: Type.String(),
    },
    { additionalProperties: false },
  ),
]);

export const DockerResourceSchema = Type.Object(
  {
    role: Type.Union([Type.Literal("agent"), Type.Literal("preparation")]),
    containerName: Type.String(),
    holderName: Type.String(),
    volumeName: Type.String(),
    containerId: NullableString,
    holderId: NullableString,
    containerCleanup: Type.Union([
      Type.Literal("reserved"),
      Type.Literal("not_created"),
      Type.Literal("pending"),
      Type.Literal("removed"),
      Type.Literal("failed"),
    ]),
    storageCleanup: Type.Union([
      Type.Literal("reserved"),
      Type.Literal("not_created"),
      Type.Literal("pending"),
      Type.Literal("removed"),
      Type.Literal("retained"),
      Type.Literal("failed"),
    ]),
  },
  { additionalProperties: false },
);

export const ResourceRecordSchema = Type.Object(
  {
    id: Uuid,
    state: Type.Union([
      Type.Literal("active"),
      Type.Literal("retained"),
      Type.Literal("completed"),
    ]),
    ownerPid: Count,
    createdAt: Type.String(),
    attemptId: Type.String({ maxLength: 128 }),
    taskSha256: Digest,
    comparisonSha256: Digest,
    reserved: ReservationSchema,
    charged: ResourceCapacitySchema,
    measurement: Type.Union([
      Type.Object(
        {
          kind: Type.Literal("unknown"),
          reason: Type.String({ maxLength: 4096 }),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal("measured"),
          poolBytes: Count,
          poolEntries: Count,
        },
        { additionalProperties: false },
      ),
    ]),
    docker: Type.Array(DockerResourceSchema, { minItems: 2, maxItems: 2 }),
    resultSha256: Type.Union([Digest, Type.Null()]),
    error: NullableString,
  },
  { additionalProperties: false },
);

export const ResourceLedgerSchema = Type.Object(
  {
    schemaVersion: Type.Literal("1"),
    poolId: Uuid,
    policySha256: Digest,
    limits: ResourceLimitsSchema,
    records: Type.Array(ResourceRecordSchema, { maxItems: 1000 }),
  },
  {
    $id: "https://agent-eval-runner.dev/schemas/resource-ledger-v1.schema.json",
    additionalProperties: false,
  },
);
export const ResourcePoolSchema = Type.Object(
  {
    schemaVersion: Type.Literal("1"),
    poolId: Uuid,
    policy: ResourcePolicyInputSchema,
  },
  { additionalProperties: false },
);
export const ResourceInventorySchema = Type.Object(
  {
    schemaVersion: Type.Literal("1"),
    root: Type.String(),
    ownership: Type.Literal("registered_only"),
    ledger: ResourceLedgerSchema,
    charged: ResourceCapacitySchema,
    lockPresent: Type.Boolean(),
    warnings: Type.Array(Type.String()),
  },
  {
    $id: "https://agent-eval-runner.dev/schemas/resource-inventory-v1.schema.json",
    additionalProperties: false,
  },
);
export const AdmissionDecisionSchema = Type.Object(
  {
    schemaVersion: Type.Literal("1"),
    kind: Type.Literal("resource_admission_denied"),
    reason: Type.Union([
      Type.Literal("capacity"),
      Type.Literal("unresolved_inventory"),
      Type.Literal("busy"),
      Type.Literal("cancelled"),
      Type.Literal("unsupported"),
      Type.Literal("inventory_error"),
    ]),
    message: Type.String({ maxLength: 4096 }),
  },
  {
    $id: "https://agent-eval-runner.dev/schemas/resource-admission-v1.schema.json",
    additionalProperties: false,
  },
);

export type ResourceLimits = Static<typeof ResourceLimitsSchema>;
export type ResourceCapacity = Static<typeof ResourceCapacitySchema>;
export type ResourcePolicyInput = Static<typeof ResourcePolicyInputSchema>;
export type ResourceIdentity = Static<typeof ResourceIdentitySchema>;
export type ResourceAccounting = Static<typeof ResourceAccountingSchema>;
export type ResourceRecord = Static<typeof ResourceRecordSchema>;
export type DockerResource = Static<typeof DockerResourceSchema>;
export type ResourceLedger = Static<typeof ResourceLedgerSchema>;
export type ResourcePool = Static<typeof ResourcePoolSchema>;
export type ResourceInventory = Static<typeof ResourceInventorySchema>;
export type AdmissionDecision = Static<typeof AdmissionDecisionSchema>;

export function parseResourcePolicy(input: unknown): ResourcePolicyInput {
  if (!Value.Check(ResourcePolicyInputSchema, input))
    throw new Error("Invalid resource policy v1");
  return input;
}
export function parseResourceLedger(input: unknown): ResourceLedger {
  if (!Value.Check(ResourceLedgerSchema, input))
    throw new Error("Invalid resource ledger v1");
  return input;
}

export function resourceIdentity(
  accounting: ResourceAccounting,
): ResourceIdentity {
  return accounting.kind === "unmanaged"
    ? accounting
    : {
        kind: "managed",
        policyVersion: accounting.policyVersion,
        limits: accounting.limits,
      };
}

export interface AttemptStorage {
  readonly temporaryDirectory: string;
  readonly agentName: string;
  readonly preparationName: string;
}
