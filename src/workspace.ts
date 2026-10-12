import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolveInside } from "./paths.js";
import { SAFETY_POLICY, SafetyDeadline } from "./safety.js";

export interface WorkspaceLimits {
  readonly bytes: number;
  readonly fileBytes: number;
  readonly entries: number;
  readonly depth: number;
}
export const WORKSPACE_LIMITS: WorkspaceLimits = {
  bytes: SAFETY_POLICY.workspaceBytes,
  fileBytes: SAFETY_POLICY.fileBytes,
  entries: SAFETY_POLICY.workspaceEntries,
  depth: SAFETY_POLICY.pathDepth,
};

export interface WorkspaceFile {
  readonly path: string;
  readonly bytes: number;
  readonly mode: "100644" | "100755";
}

export function assertPortablePath(
  path: string,
  depth: number = SAFETY_POLICY.pathDepth,
): void {
  const parts = path.split("/");
  if (
    path.length === 0 ||
    path.length > 1024 ||
    parts.length > depth ||
    path !== path.normalize("NFC") ||
    parts.some(
      (part) =>
        part === "" ||
        part === "." ||
        part === ".." ||
        part.toLowerCase() === ".git" ||
        /\p{Cc}/u.test(part) ||
        /[\\:<>"|?*]/u.test(part) ||
        /~[0-9]/u.test(part) ||
        /[. ]$/u.test(part) ||
        /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(part),
    )
  ) {
    throw new Error(`Unsupported or over-depth workspace path: ${path}`);
  }
}

// Reject case aliases on every platform, so the same tree has one portable interpretation.
export function registerPath(path: string, paths: Map<string, string>): void {
  const parts = path.split("/");
  for (let index = 1; index <= parts.length; index += 1) {
    const prefix = parts.slice(0, index).join("/");
    const folded = prefix.toLowerCase();
    const existing = paths.get(folded);
    if (existing !== undefined && existing !== prefix)
      throw new Error(`Case-colliding workspace paths: ${existing}, ${prefix}`);
    paths.set(folded, prefix);
  }
}

export async function scanWorkspace(
  root: string,
  deadline = new SafetyDeadline(),
  options: { skipRootGit?: boolean; limits?: WorkspaceLimits } = {},
): Promise<WorkspaceFile[]> {
  const limits = options.limits ?? WORKSPACE_LIMITS;
  const files: WorkspaceFile[] = [];
  const paths = new Map<string, string>();
  let bytes = 0;
  let entries = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    deadline.remainingMs();
    const opened = await opendir(directory, { bufferSize: 32 });
    for await (const entry of opened) {
      deadline.remainingMs();
      if (
        prefix === "" &&
        entry.name === ".git" &&
        options.skipRootGit === true
      )
        continue;
      entries += 1;
      if (entries > limits.entries)
        throw new Error(
          `Workspace entry limit exceeded: ${String(limits.entries)}`,
        );
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      assertPortablePath(path, limits.depth);
      registerPath(path, paths);
      const metadata = await lstat(join(directory, entry.name));
      if (metadata.isDirectory())
        await visit(join(directory, entry.name), path);
      else if (metadata.isFile() && metadata.nlink === 1) {
        if (metadata.size > limits.fileBytes)
          throw new Error(`Workspace file byte limit exceeded: ${path}`);
        bytes += metadata.size;
        if (bytes > limits.bytes)
          throw new Error(
            `Workspace byte limit exceeded: ${String(limits.bytes)}`,
          );
        files.push({
          path,
          bytes: metadata.size,
          mode: (metadata.mode & 0o111) === 0 ? "100644" : "100755",
        });
      } else
        throw new Error(
          `Workspace accepts only single-link regular files and directories: ${path}`,
        );
    }
  };
  await visit(await realpath(root), "");
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

// Validate each component, refuse links/special files, and read no more than maxBytes + 1.
export async function readBoundedFile(
  root: string,
  path: string,
  maxBytes: number,
  deadline = new SafetyDeadline(),
): Promise<Buffer> {
  assertPortablePath(path);
  const canonical = await realpath(root);
  let current = canonical;
  const parts = path.split("/");
  for (const [index, part] of parts.entries()) {
    deadline.remainingMs();
    current = resolveInside(current, part);
    const metadata = await lstat(current);
    if (index === parts.length - 1) {
      if (!metadata.isFile() || metadata.nlink !== 1)
        throw new Error(`Artifact is not a single-link regular file: ${path}`);
    } else if (!metadata.isDirectory())
      throw new Error(
        `Workspace path traverses a link or non-directory: ${path}`,
      );
  }
  const flags =
    process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(current, flags);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1)
      throw new Error(`Artifact is not a single-link regular file: ${path}`);
    if (metadata.size > maxBytes)
      throw new Error(
        `File exceeds the ${String(maxBytes)} byte limit: ${path}`,
      );
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      deadline.remainingMs();
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - bytes));
      const read = await handle.read(chunk, 0, chunk.length, null);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
      if (bytes > maxBytes)
        throw new Error(
          `File exceeds the ${String(maxBytes)} byte limit: ${path}`,
        );
      chunks.push(chunk.subarray(0, read.bytesRead));
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    await handle.close();
  }
}

export async function copyWorkspaceFiles(
  source: string,
  target: string,
  files: readonly WorkspaceFile[],
  deadline: SafetyDeadline,
): Promise<void> {
  let bytes = 0;
  await mkdir(target, { recursive: true });
  for (const file of files) {
    const content = await readBoundedFile(
      source,
      file.path,
      Math.min(SAFETY_POLICY.fileBytes, SAFETY_POLICY.workspaceBytes - bytes),
      deadline,
    );
    bytes += content.length;
    const destination = resolveInside(target, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, {
      mode: file.mode === "100755" ? 0o755 : 0o644,
      flag: "wx",
    });
  }
}
