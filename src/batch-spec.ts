import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { parseTaskSpec, TaskSpecSchema } from "./spec.js";
import { ResourceIdentitySchema } from "./resources-spec.js";

export const DigestSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });
const Identifier = TaskSpecSchema.properties.id;
const CommonTaskSchema = Type.Omit(TaskSpecSchema, ["adapter", "$schema"], {
  $id: "https://agent-eval-runner.dev/schemas/batch-common-task-v1",
  additionalProperties: false,
});

export const BatchSpecSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    schemaVersion: Type.Literal("1"),
    id: Identifier,
    task: CommonTaskSchema,
    configurations: Type.Array(
      Type.Object(
        {
          id: Identifier,
          adapter: TaskSpecSchema.properties.adapter,
          repetitions: Type.Integer({ minimum: 1, maximum: 1000 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 1000 },
    ),
  },
  {
    $id: "https://agent-eval-runner.dev/schemas/batch-v1.schema.json",
    additionalProperties: false,
  },
);

const EntryIdentity = {
  id: Identifier,
  configurationId: Identifier,
  repetition: Type.Integer({ minimum: 1 }),
  adapterSha256: DigestSchema,
};

export const BatchEntrySchema = Type.Union([
  Type.Object(
    {
      ...EntryIdentity,
      state: Type.Literal("pending"),
      resultFile: Type.Null(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...EntryIdentity,
      state: Type.Literal("running"),
      resultFile: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...EntryIdentity,
      state: Type.Literal("finished"),
      resultFile: Type.String(),
      resultSha256: DigestSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...EntryIdentity,
      state: Type.Literal("not_started"),
      resultFile: Type.Null(),
      reason: Type.Union([
        Type.Literal("cancelled"),
        Type.Literal("persistence_error"),
        Type.Literal("resource_admission"),
      ]),
      error: Type.Optional(Type.String({ maxLength: 4096 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...EntryIdentity,
      state: Type.Literal("persistence_failed"),
      resultFile: Type.Null(),
      error: Type.String(),
    },
    { additionalProperties: false },
  ),
]);

export const BatchIndexSchema = Type.Object(
  {
    schemaVersion: Type.Literal("2"),
    resourceIdentity: ResourceIdentitySchema,
    id: Identifier,
    batchSha256: DigestSchema,
    comparisonSha256: DigestSchema,
    state: Type.Union([
      Type.Literal("active"),
      Type.Literal("completed"),
      Type.Literal("cancelled"),
      Type.Literal("failed"),
    ]),
    attempts: Type.Array(BatchEntrySchema, { minItems: 1 }),
  },
  {
    $id: "https://agent-eval-runner.dev/schemas/batch-index-v2.schema.json",
    additionalProperties: false,
  },
);

export const UnfinishedEntrySchema = Type.Union([
  BatchEntrySchema.anyOf[0],
  BatchEntrySchema.anyOf[1],
  BatchEntrySchema.anyOf[3],
  BatchEntrySchema.anyOf[4],
]);

export type BatchSpec = Static<typeof BatchSpecSchema>;
export type BatchEntry = Static<typeof BatchEntrySchema>;
export type BatchIndex = Static<typeof BatchIndexSchema>;

export function parseBatchSpec(input: unknown): BatchSpec {
  if (!Value.Check(BatchSpecSchema, input)) {
    const error = Value.Errors(BatchSpecSchema, input).First();
    throw new Error(
      `Invalid batch specification: ${error?.path ?? "/"} ${error?.message ?? "Invalid value"}`,
    );
  }
  const ids = new Set(input.configurations.map(({ id }) => id));
  if (ids.size !== input.configurations.length)
    throw new Error("Configuration IDs must be unique");
  if (
    input.configurations.reduce(
      (total, entry) => total + entry.repetitions,
      0,
    ) > 10_000
  ) {
    throw new Error("A batch may schedule at most 10000 attempts");
  }
  parseTaskSpec({ ...input.task, adapter: { kind: "fake", actions: [] } });
  return input;
}

export function parseBatchIndex(input: unknown): BatchIndex {
  if (!Value.Check(BatchIndexSchema, input))
    throw new Error("Invalid batch index, expected version 2");
  const ids = new Set(input.attempts.map(({ id }) => id));
  if (ids.size !== input.attempts.length)
    throw new Error("Batch attempt IDs must be unique");
  return input;
}
