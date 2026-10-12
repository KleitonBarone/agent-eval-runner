import { spawn } from "node:child_process";

import type { Redactor } from "./redaction.js";
import { sha256 } from "./identity.js";
import type { CommandResult } from "./result.js";

export type ProcessTermination = "wall_clock" | "check_timeout" | "cancelled";

export interface ProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly timeoutTermination: Exclude<ProcessTermination, "cancelled">;
  readonly maxOutputBytes: number;
  readonly maxPersistedOutputBytes?: number;
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
  readonly outputDigests?: NonNullable<CommandResult["outputDigests"]>;
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
  if (
    request.maxPersistedOutputBytes !== undefined &&
    (!Number.isSafeInteger(request.maxPersistedOutputBytes) ||
      request.maxPersistedOutputBytes < 0)
  )
    throw new Error("Invalid persisted output byte limit");
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

  const stdoutCaptured = Buffer.concat(stdout, stdoutBytes);
  const stderrCaptured = Buffer.concat(stderr, stderrBytes);
  const stdoutRedacted = redact(stdoutCaptured.toString("utf8"));
  const stderrRedacted = redact(stderrCaptured.toString("utf8"));
  const limit = request.maxPersistedOutputBytes;
  const trim = (value: string) => {
    const bytes = Buffer.from(value);
    if (limit === undefined || bytes.length <= limit)
      return { value, truncated: false };
    let end = limit;
    // Buffer slicing alone can add a replacement character beyond the byte budget.
    while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    return { value: bytes.subarray(0, end).toString("utf8"), truncated: true };
  };
  const sanitizedStdout = trim(stdoutRedacted);
  const sanitizedStderr = trim(stderrRedacted);
  const stdoutPersisted = sanitizedStdout.value;
  const stderrPersisted = sanitizedStderr.value;
  if (sanitizedStdout.truncated) stdoutTruncated = true;
  if (sanitizedStderr.truncated) stderrTruncated = true;
  return {
    command: redact(request.command),
    args: request.args.map(redact),
    cwd: request.cwd,
    exitCode: closed.code,
    signal: closed.signal,
    stdout: stdoutPersisted,
    stderr: stderrPersisted,
    stdoutTruncated,
    stderrTruncated,
    ...(limit === undefined
      ? {}
      : {
          outputDigests: {
            stdoutCapturedSha256: sha256(stdoutCaptured),
            stderrCapturedSha256: sha256(stderrCaptured),
            stdoutPersistedSha256: sha256(stdoutPersisted),
            stderrPersistedSha256: sha256(stderrPersisted),
          },
        }),
    durationMs: Math.round((performance.now() - startedAt) * 1_000) / 1_000,
    termination,
    error: spawnError,
  };
}
