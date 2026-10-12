import { Type, type Static } from "@sinclair/typebox";

import { DigestSchema, UnfinishedEntrySchema } from "./batch-spec.js";
import { CheckResultSchema, ResultSpecSchema } from "./result.js";
import { TaskSpecSchema } from "./spec.js";
import { UsageSchema } from "./usage.js";

const Count = Type.Integer({ minimum: 0 });

export const FinishedComparisonRowSchema = Type.Object(
  {
    state: Type.Literal("finished"),
    id: Type.String(),
    configurationId: Type.String(),
    repetition: Type.Integer({ minimum: 1 }),
    resultFile: Type.String(),
    resultSha256: DigestSchema,
    taskSha256: DigestSchema,
    adapterSha256: DigestSchema,
    adapter: TaskSpecSchema.properties.adapter,
    runner: ResultSpecSchema.properties.runner,
    source: ResultSpecSchema.properties.source,
    execution: ResultSpecSchema.properties.execution,
    safety: ResultSpecSchema.properties.safety,
    status: ResultSpecSchema.properties.status,
    outcome: ResultSpecSchema.properties.attempt.properties.outcome,
    score: ResultSpecSchema.properties.score,
    checks: Type.Array(Type.Omit(CheckResultSchema, ["command"])),
    durationMs: Type.Number({ minimum: 0 }),
    commandCount: Count,
    patchBytes: Type.Union([Count, Type.Null()]),
    usage: UsageSchema,
    errors: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const ComparisonSpecSchema = Type.Object(
  {
    schemaVersion: Type.Literal("4"),
    batchId: Type.String(),
    comparisonSha256: DigestSchema,
    scoringVersion: Type.Literal("2"),
    rows: Type.Array(
      Type.Union([FinishedComparisonRowSchema, UnfinishedEntrySchema]),
      { minItems: 1 },
    ),
    summary: Type.Object(
      {
        scheduled: Count,
        finished: Count,
        succeeded: Count,
        failed: Count,
        interrupted: Count,
        notStarted: Count,
        pending: Count,
        running: Count,
        persistenceFailed: Count,
        usage: UsageSchema,
      },
      { additionalProperties: false },
    ),
    warnings: Type.Array(Type.String()),
  },
  {
    $id: "https://agent-eval-runner.dev/schemas/comparison-v4.schema.json",
    additionalProperties: false,
  },
);

export type ComparisonSpec = Static<typeof ComparisonSpecSchema>;
export type FinishedComparisonRow = Static<typeof FinishedComparisonRowSchema>;
