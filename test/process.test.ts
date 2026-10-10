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

it("captures and redacts output from piped input", async () => {
  const result = await runProcess(
    {
      command: process.execPath,
      args: ["-e", "process.stdin.pipe(process.stdout)"],
      input: "API_KEY=private-stdin-value\n",
      cwd: process.cwd(),
      timeoutMs: 2000,
      timeoutTermination: "check_timeout",
      maxOutputBytes: 1024,
    },
    createRedactor([]),
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("API_KEY=[REDACTED]\n");
});
