import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { RunEventSchema } from "./events.js";
import { ExecutionEvidenceSchema } from "./execution-spec.js";
import { TaskSpecSchema } from "./spec.js";
import { UsageSchema } from "./usage.js";
import { SafetyPolicySchema } from "./safety.js";
import { ResourceAccountingSchema } from "./resources-spec.js";

const NullableString = Type.Union([Type.String(), Type.Null()]);
const Termination = Type.Union([
  Type.Literal("wall_clock"),
  Type.Literal("check_timeout"),
  Type.Literal("cancelled"),
  Type.Null(),
]);

export const CommandResultSchema = Type.Object(
  {
    id: Type.String(),
    command: Type.String(),
    args: Type.Array(Type.String()),
    cwd: Type.String(),
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    signal: NullableString,
    stdout: Type.String(),
    stderr: Type.String(),
    stdoutTruncated: Type.Boolean(),
    stderrTruncated: Type.Boolean(),
    outputDigests: Type.Optional(
      Type.Object(
        {
          stdoutCapturedSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
          stderrCapturedSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
          stdoutPersistedSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
          stderrPersistedSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
        },
        { additionalProperties: false },
      ),
    ),
    durationMs: Type.Number({ minimum: 0 }),
    termination: Termination,
    error: NullableString,
  },
  { additionalProperties: false },
);

const CheckIdentity = {
  id: Type.String(),
  kind: Type.Union([
    Type.Literal("test"),
    Type.Literal("lint"),
    Type.Literal("custom"),
  ]),
};

export const CheckResultSchema = Type.Union([
  Type.Object(
    {
      ...CheckIdentity,
      status: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
      command: CommandResultSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CheckIdentity,
      status: Type.Literal("skipped"),
      reason: Type.Union([
        Type.Literal("cancelled"),
        Type.Literal("wall_clock_exceeded"),
        Type.Literal("checkout_failed"),
        Type.Literal("check_error"),
        Type.Literal("execution_failed"),
      ]),
      command: Type.Null(),
    },
    { additionalProperties: false },
  ),
]);

export const ResultSpecSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    schemaVersion: Type.Literal("7"),
    resourceAccounting: ResourceAccountingSchema,
    safety: SafetyPolicySchema,
    execution: ExecutionEvidenceSchema,
    runner: Type.Object(
      {
        name: Type.Literal("agent-eval-runner"),
        version: Type.String(),
        node: Type.String(),
        platform: Type.String(),
        arch: Type.String(),
      },
      { additionalProperties: false },
    ),
    task: TaskSpecSchema,
    taskSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    comparisonSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    adapterSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    usage: UsageSchema,
    status: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("interrupted"),
    ]),
    source: Type.Object(
      {
        repositoryPath: Type.String(),
        requestedRevision: Type.String(),
        resolvedRevision: NullableString,
      },
      { additionalProperties: false },
    ),
    attempt: Type.Object(
      {
        id: Type.String({ minLength: 1 }),
        configurationId: Type.String({ minLength: 1 }),
        repetition: Type.Integer({ minimum: 1 }),
        adapter: Type.Literal("fake"),
        outcome: Type.Union([
          Type.Literal("completed"),
          Type.Literal("agent_failed"),
          Type.Literal("command_budget_exceeded"),
          Type.Literal("wall_clock_exceeded"),
          Type.Literal("cancelled"),
          Type.Literal("runner_error"),
        ]),
        durationMs: Type.Number({ minimum: 0 }),
        commandCount: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    commands: Type.Array(CommandResultSchema),
    patch: Type.Object(
      {
        captured: Type.Boolean(),
        bytes: Type.Integer({ minimum: 0 }),
        originalBytes: Type.Integer({ minimum: 0 }),
        sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
        originalSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
        redacted: Type.Boolean(),
        content: Type.String(),
      },
      { additionalProperties: false },
    ),
    artifacts: Type.Array(
      Type.Object(
        {
          path: Type.String(),
          mediaType: Type.String(),
          bytes: Type.Integer({ minimum: 0 }),
          originalBytes: Type.Integer({ minimum: 0 }),
          sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
          originalSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
          redacted: Type.Boolean(),
          contentBase64: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    checks: Type.Array(CheckResultSchema),
    score: Type.Object(
      {
        version: Type.Literal("2"),
        passed: Type.Integer({ minimum: 0 }),
        failed: Type.Integer({ minimum: 0 }),
        skipped: Type.Integer({ minimum: 0 }),
        total: Type.Integer({ minimum: 0 }),
        ratio: Type.Union([
          Type.Number({ minimum: 0, maximum: 1 }),
          Type.Null(),
        ]),
      },
      { additionalProperties: false },
    ),
    events: Type.Array(RunEventSchema),
    errors: Type.Array(Type.String()),
    workspace: Type.Object(
      {
        retained: Type.Boolean(),
        path: NullableString,
      },
      { additionalProperties: false },
    ),
  },
  {
    $id: "https://agent-eval-runner.dev/schemas/result-v7.schema.json",
    additionalProperties: false,
  },
);

export type CommandResult = Static<typeof CommandResultSchema>;
export type CheckResult = Static<typeof CheckResultSchema>;
export type ResultSpec = Static<typeof ResultSpecSchema>;

export function assertResultSpec(input: unknown): asserts input is ResultSpec {
  if (Value.Check(ResultSpecSchema, input)) return;
  const details = [...Value.Errors(ResultSpecSchema, input)]
    .slice(0, 5)
    .map(({ message, path }) => `${path || "/"}: ${message}`)
    .join("; ");
  throw new Error(`Runner produced an invalid result: ${details}`);
}

export function parseResultSpec(input: unknown): ResultSpec {
  if (
    typeof input === "object" &&
    input !== null &&
    "schemaVersion" in input &&
    input.schemaVersion !== "7"
  ) {
    throw new Error(
      "Unsupported result version. Comparisons require result version 7.",
    );
  }
  assertResultSpec(input);
  return input;
}
