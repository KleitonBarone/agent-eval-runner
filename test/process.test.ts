import { expect, it } from "vitest";

import { runProcess } from "../src/process.js";
import { createRedactor } from "../src/redaction.js";

it("terminates commands even when the abort signal was already raised", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runProcess(
    {
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      timeoutMs: 2_000,
      timeoutTermination: "wall_clock",
      maxOutputBytes: 1024,
      signal: controller.signal,
    },
    createRedactor([]),
  );
  expect(result.termination).toBe("cancelled");
});
