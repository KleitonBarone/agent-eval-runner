import type { ProcessResult } from "./process.js";
import type { TaskSpec } from "./spec.js";

type FakeAction = TaskSpec["adapter"]["actions"][number];

export type FakeAgentOutcome =
  | "completed"
  | "agent_failed"
  | "command_budget_exceeded"
  | "wall_clock_exceeded"
  | "cancelled";

export interface FakeAgentContext {
  readonly writeFile: (
    action: Extract<FakeAction, { kind: "writeFile" }>,
  ) => Promise<"wall_clock" | "cancelled" | null>;
  readonly actions: readonly FakeAction[];
  readonly execute: (
    action: Extract<FakeAction, { kind: "runCommand" }>,
  ) => Promise<ProcessResult | null>;
  readonly outcomeAfterSkippedCommand: () =>
    "command_budget_exceeded" | "wall_clock_exceeded" | "cancelled";
  readonly signal?: AbortSignal;
  readonly deadline: number;
}

export async function runFakeAgent(
  context: FakeAgentContext,
): Promise<FakeAgentOutcome> {
  for (const action of context.actions) {
    if (context.signal?.aborted === true) return "cancelled";
    if (performance.now() >= context.deadline) return "wall_clock_exceeded";

    if (action.kind === "writeFile") {
      const termination = await context.writeFile(action);
      if (termination === "cancelled") return "cancelled";
      if (termination === "wall_clock") return "wall_clock_exceeded";
      continue;
    }

    const result = await context.execute(action);
    if (result === null) return context.outcomeAfterSkippedCommand();
    if (result.termination === "cancelled") return "cancelled";
    if (result.termination === "wall_clock") return "wall_clock_exceeded";
    if (result.exitCode !== 0 || result.error !== null) return "agent_failed";
  }
  return "completed";
}
