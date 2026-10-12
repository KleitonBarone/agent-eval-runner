import { spawn } from "node:child_process";

import type { Redactor } from "./redaction.js";

export type ProcessTermination = "wall_clock" | "check_timeout" | "cancelled";

export interface ProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly timeoutTermination: Exclude<ProcessTermination, "cancelled">;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly input?: string;
}

export interface ProcessResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
  readonly termination: ProcessTermination | null;
  readonly error: string | null;
}

function childEnvironment(
  additions: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const names = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "ComSpec",
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return { ...environment, ...additions };
}

async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("close", () => {
        resolve();
      });
      killer.once("error", () => {
        resolve();
      });
    });
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process may have exited between the timeout and the kill.
    }
  }
}

export async function runProcess(
  request: ProcessRequest,
  redact: Redactor,
): Promise<ProcessResult> {
  const startedAt = performance.now();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let termination: ProcessTermination | null = null;
  let spawnError: string | null = null;

  const child = spawn(request.command, [...request.args], {
    cwd: request.cwd,
    env: childEnvironment(request.env),
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const append = (
    current: Buffer[],
    bytes: number,
    chunk: Buffer,
    markTruncated: () => void,
  ): number => {
    const remaining = request.maxOutputBytes - bytes;
    if (remaining <= 0) {
      markTruncated();
      return bytes;
    }
    if (chunk.byteLength > remaining) markTruncated();
    const accepted = chunk.subarray(0, remaining);
    current.push(accepted);
    return bytes + accepted.length;
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes = append(stdout, stdoutBytes, chunk, () => {
      stdoutTruncated = true;
    });
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes = append(stderr, stderrBytes, chunk, () => {
      stderrTruncated = true;
    });
  });
  child.once("error", (error) => {
    spawnError = redact(error.message);
  });
  child.stdin.on("error", (error: Error) => {
    if (!("code" in error) || error.code !== "EPIPE")
      spawnError = redact(error.message);
  });
  child.stdin.end(request.input);

  const terminate = (reason: ProcessTermination): void => {
    if (termination !== null || child.exitCode !== null) return;
    termination = reason;
    if (child.pid !== undefined) void killProcessTree(child.pid);
  };
  const timer = setTimeout(() => {
    terminate(request.timeoutTermination);
  }, request.timeoutMs);
  const abort = (): void => {
    terminate("cancelled");
  };
  request.signal?.addEventListener("abort", abort, { once: true });
  if (request.signal?.aborted === true) abort();

  const closed = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
  clearTimeout(timer);
  request.signal?.removeEventListener("abort", abort);

  return {
    command: redact(request.command),
    args: request.args.map(redact),
    cwd: request.cwd,
    exitCode: closed.code,
    signal: closed.signal,
    stdout: redact(Buffer.concat(stdout, stdoutBytes).toString("utf8")),
    stderr: redact(Buffer.concat(stderr, stderrBytes).toString("utf8")),
    stdoutTruncated,
    stderrTruncated,
    durationMs: Math.round((performance.now() - startedAt) * 1_000) / 1_000,
    termination,
    error: spawnError,
  };
}
