import { Type, type Static, type TProperties } from "@sinclair/typebox";

const EventMetadata = {
  sequence: Type.Integer({ minimum: 0 }),
  elapsedMs: Type.Number({ minimum: 0 }),
};

function eventSchema<T extends TProperties>(properties: T) {
  return Type.Object(
    { ...EventMetadata, ...properties },
    { additionalProperties: false },
  );
}

export const RunEventSchema = Type.Union([
  eventSchema({ type: Type.Literal("run.started") }),
  eventSchema({
    type: Type.Literal("checkout.prepared"),
    revision: Type.String(),
  }),
  eventSchema({
    type: Type.Literal("agent.started"),
    adapter: Type.Literal("fake"),
  }),
  eventSchema({
    type: Type.Literal("command.started"),
    commandId: Type.String(),
    command: Type.String(),
    args: Type.Array(Type.String()),
  }),
  eventSchema({
    type: Type.Literal("command.finished"),
    commandId: Type.String(),
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    termination: Type.Union([Type.String(), Type.Null()]),
  }),
  eventSchema({
    type: Type.Literal("budget.exceeded"),
    budget: Type.Union([Type.Literal("commands"), Type.Literal("wall_clock")]),
  }),
  eventSchema({ type: Type.Literal("agent.finished"), outcome: Type.String() }),
  eventSchema({
    type: Type.Literal("patch.captured"),
    bytes: Type.Integer({ minimum: 0 }),
  }),
  eventSchema({
    type: Type.Literal("artifact.captured"),
    path: Type.String(),
    bytes: Type.Integer({ minimum: 0 }),
  }),
  eventSchema({ type: Type.Literal("check.started"), checkId: Type.String() }),
  eventSchema({
    type: Type.Literal("check.finished"),
    checkId: Type.String(),
    status: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
  }),
  eventSchema({
    type: Type.Literal("check.skipped"),
    checkId: Type.String(),
    reason: Type.String(),
  }),
  eventSchema({
    type: Type.Literal("score.computed"),
    passed: Type.Integer({ minimum: 0 }),
    total: Type.Integer({ minimum: 0 }),
  }),
  eventSchema({
    type: Type.Literal("run.finished"),
    status: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("interrupted"),
    ]),
  }),
]);

export const RunEventDataSchema = Type.Omit(RunEventSchema, [
  "sequence",
  "elapsedMs",
]);
export type RunEventData = Static<typeof RunEventDataSchema>;
export type RunEvent = Static<typeof RunEventSchema>;

export class EventRecorder {
  readonly events: RunEvent[] = [];
  readonly #startedAt = performance.now();

  record(event: RunEventData): void {
    this.events.push({
      ...event,
      sequence: this.events.length,
      elapsedMs: Math.max(
        0,
        Math.round((performance.now() - this.#startedAt) * 1_000) / 1_000,
      ),
    });
  }
}
