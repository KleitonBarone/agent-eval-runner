import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { PREPARATION_POLICY } from "./execution-spec.js";
import { canonicalJson, sha256 } from "./identity.js";
import type { PreparedCheckout } from "./git.js";
import type { SafetyDeadline } from "./safety.js";
import { readBoundedFile } from "./workspace.js";

async function directory(path: string): Promise<boolean> {
  const entry = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  });
  if (entry === null) return false;
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new Error(`Expected a real object-store directory: ${path}`);
  return true;
}

export async function createSnapshotCheckout(
  sourcePath: string,
  revision: string,
  temporaryDirectory = tmpdir(),
): Promise<PreparedCheckout> {
  const source = await realpath(resolve(sourcePath));
  const rootPath = await mkdtemp(
    join(temporaryDirectory, "agent-eval-worktree-"),
  );
  const path = join(rootPath, "checkout");
  const gitPath = join(rootPath, "git");
  await mkdir(path);
  await mkdir(gitPath);
  await writeFile(
    join(rootPath, "source.json"),
    JSON.stringify({ sourcePath: source }),
  );
  return { sourcePath: source, rootPath, gitPath, path, revision };
}

// Copy opaque object bytes, never invoke Git or interpret source configuration.
export interface SnapshotLimits {
  readonly snapshotBytes: number;
  readonly snapshotFileBytes: number;
  readonly snapshotEntries: number;
}
export async function snapshotObjects(
  source: string,
  target: string,
  deadline: SafetyDeadline,
  limits: SnapshotLimits = PREPARATION_POLICY,
) {
  const metadata = (await directory(join(source, ".git")))
    ? join(source, ".git")
    : source;
  const objects = join(metadata, "objects");
  if (!(await directory(objects)))
    throw new Error(
      "Docker preparation requires a standalone SHA-1 repository; linked worktrees are unsupported",
    );
  if (await directory(join(objects, "info"))) {
    for (const name of ["alternates", "http-alternates"]) {
      const candidate = join(objects, "info", name);
      const exists = await lstat(candidate).then(
        () => true,
        (error: unknown) => {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return false;
          throw error;
        },
      );
      if (
        exists &&
        (await readBoundedFile(objects, `info/${name}`, 4096, deadline))
          .length > 0
      )
        throw new Error(
          "External Git alternates are unsupported by Docker preparation",
        );
    }
  }
  const records: { path: string; bytes: number; sha256: string }[] = [];
  let bytes = 0;
  let entries = 0;
  const copy = async (path: string) => {
    const content = await readBoundedFile(
      objects,
      path,
      Math.min(limits.snapshotFileBytes, limits.snapshotBytes - bytes),
      deadline,
    );
    bytes += content.length;
    const destination = join(target, ...path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, { flag: "wx", mode: 0o444 });
    records.push({
      path,
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  };
  const visit = async (folder: string, prefix: string) => {
    const opened = await opendir(folder, { bufferSize: 32 });
    for await (const entry of opened) {
      deadline.remainingMs();
      if (++entries > limits.snapshotEntries)
        throw new Error("Object snapshot entry limit exceeded");
      if (prefix === "" && entry.name === "info") continue;
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const stat = await lstat(join(folder, entry.name));
      if (
        prefix === "" &&
        (entry.name === "pack" || /^[0-9a-f]{2}$/u.test(entry.name))
      ) {
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error("Object snapshot rejects links and non-directories");
        await visit(join(folder, entry.name), path);
      } else {
        if (!stat.isFile() || stat.nlink !== 1)
          throw new Error(
            "Object snapshot accepts single-link regular files only",
          );
        if (
          /^[0-9a-f]{2}\/[0-9a-f]{38}$/u.test(path) ||
          /^pack\/pack-[0-9a-f]{40}\.(?:pack|idx)$/u.test(path)
        )
          await copy(path);
        else if (
          !/^pack\/pack-[0-9a-f]{40}\.(?:rev|bitmap|keep|promisor|mtimes)$/u.test(
            path,
          )
        )
          throw new Error(`Unsupported object-store entry: ${path}`);
      }
    }
  };
  await mkdir(target, { recursive: true });
  await visit(objects, "");
  records.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const sha = sha256(canonicalJson(records));
  return { sha256: sha, bytes, entries: records.length, records };
}
