import {
  reserveResources,
  ResourceAdmissionError,
} from "../../src/resources.js";
import { parseTaskSpec } from "../../src/spec.js";

// Admission only. This trusted helper never invokes Git, Docker, or an adapter.
const root = process.argv[2];
if (root === undefined) throw new Error("Missing fixture resource root");
try {
  const lease = await reserveResources(
    root,
    parseTaskSpec({
      schemaVersion: "1",
      id: "resource-worker",
      repository: { path: process.cwd(), revision: "a".repeat(40) },
      execution: { kind: "docker", image: `node@sha256:${"b".repeat(64)}` },
      prompt: "Reserve capacity without execution",
      adapter: { kind: "fake", actions: [] },
      budgets: { wallClockMs: 1000, maxCommands: 0, maxOutputBytes: 1024 },
      checks: [],
      artifacts: [],
    }),
    "worker",
  );
  process.stdout.write(
    `${JSON.stringify({ reservationId: lease.record.id })}\n`,
  );
} catch (error) {
  if (!(error instanceof ResourceAdmissionError)) throw error;
  process.stdout.write(`${JSON.stringify(error.decision)}\n`);
  process.exitCode = 2;
}
