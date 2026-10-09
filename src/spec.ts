import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const Identifier = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$",
});
const RelativePath = Type.String({ minLength: 1, maxLength: 1_024 });
const GitCommit = Type.String({ pattern: "^[0-9a-fA-F]{40}$" });
const StringMap = Type.Record(Type.String(), Type.String());

export const FakeActionSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("writeFile"),
      path: RelativePath,
      content: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("runCommand"),
      command: Type.String({ minLength: 1 }),
      args: Type.Array(Type.String()),
      cwd: Type.Optional(RelativePath),
      env: Type.Optional(StringMap),
    },
    { additionalProperties: false },
  ),
]);

export const TaskSpecSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    schemaVersion: Type.Literal("1"),
    id: Identifier,
    repository: Type.Object(
      {
        path: Type.String({ minLength: 1 }),
        revision: GitCommit,
      },
      { additionalProperties: false },
    ),
    prompt: Type.String({ minLength: 1 }),
    adapter: Type.Object(
      {
        kind: Type.Literal("fake"),
        actions: Type.Array(FakeActionSchema),
      },
      { additionalProperties: false },
    ),
    budgets: Type.Object(
      {
        wallClockMs: Type.Integer({ minimum: 1 }),
        maxCommands: Type.Integer({ minimum: 0 }),
        maxOutputBytes: Type.Integer({ minimum: 1 }),
        maxArtifactBytes: Type.Optional(Type.Integer({ minimum: 1 })),
      },
      { additionalProperties: false },
    ),
    checks: Type.Array(
      Type.Object(
        {
          id: Identifier,
          kind: Type.Union([
            Type.Literal("test"),
            Type.Literal("lint"),
            Type.Literal("custom"),
          ]),
          command: Type.String({ minLength: 1 }),
          args: Type.Array(Type.String()),
          cwd: Type.Optional(RelativePath),
          env: Type.Optional(StringMap),
          timeoutMs: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
    artifacts: Type.Array(
      Type.Object(
        {
          path: RelativePath,
          mediaType: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  {
    $id: "https://agent-eval-runner.dev/schemas/task-v1.schema.json",
    additionalProperties: false,
  },
);

export type TaskSpec = Static<typeof TaskSpecSchema>;

export function parseTaskSpec(input: unknown): TaskSpec {
  if (Value.Check(TaskSpecSchema, input)) {
    if (
      new Set(input.checks.map(({ id }) => id)).size !== input.checks.length
    ) {
      throw new Error("Check IDs must be unique");
    }
    return input;
  }

  const details = [...Value.Errors(TaskSpecSchema, input)]
    .slice(0, 5)
    .map(({ message, path }) => `${path || "/"}: ${message}`)
    .join("; ");
  throw new Error(`Invalid task specification: ${details}`);
}
