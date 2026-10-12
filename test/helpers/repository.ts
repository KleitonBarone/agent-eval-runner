import { execFile } from "node:child_process";
import {
  mkdtemp,
  opendir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositories = new Set<string>();

export async function createTestRepository(
  files: Readonly<Record<string, string>> = { "README.md": "fixture\n" },
): Promise<{ path: string; revision: string }> {
  const path = await mkdtemp(join(tmpdir(), "agent-eval-source-"));
  repositories.add(path);
  await execFileAsync("git", ["init", "--quiet"], { cwd: path });

  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(path, name), content, "utf8");
  }

  await execFileAsync("git", ["add", "."], { cwd: path });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: path },
  );
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: path,
  });
  return { path, revision: stdout.trim() };
}

export async function removeTestWorktree(
  repositoryPath: string,
  worktreePath: string,
): Promise<void> {
  const root = await realpath(dirname(worktreePath));
  if (
    basename(worktreePath) !== "checkout" ||
    !basename(root).startsWith("agent-eval-worktree-") ||
    !(await retainedTestWorktrees(repositoryPath)).includes(
      join(root, "checkout"),
    )
  )
    throw new Error(`Not an owned fixture checkout: ${worktreePath}`);
  await rm(root, { recursive: true, force: true });
}

export async function retainedTestWorktrees(
  repositoryPath: string,
): Promise<string[]> {
  const repositoryRoot = resolve(await realpath(repositoryPath)).toLowerCase();
  const root = await realpath(tmpdir());
  const retained: string[] = [];
  const directory = await opendir(root);
  for await (const entry of directory) {
    if (!entry.isDirectory() || !entry.name.startsWith("agent-eval-worktree-"))
      continue;
    const marker = await readFile(
      join(root, entry.name, "source.json"),
      "utf8",
    ).catch(() => null);
    if (marker === null) continue;
    const value: unknown = JSON.parse(marker);
    if (
      typeof value === "object" &&
      value !== null &&
      "sourcePath" in value &&
      typeof value.sourcePath === "string" &&
      resolve(value.sourcePath).toLowerCase() === repositoryRoot
    )
      retained.push(join(root, entry.name, "checkout"));
  }
  return retained;
}

export async function cleanupTestRepositories(): Promise<void> {
  const temporaryRoot = resolve(tmpdir());
  for (const repository of repositories) {
    const target = resolve(repository);
    const relation = relative(temporaryRoot, target);
    if (
      relation === "" ||
      relation === ".." ||
      relation.startsWith(`..${sep}`)
    ) {
      throw new Error(
        `Refusing to remove test repository outside the temporary directory: ${target}`,
      );
    }
    for (const checkout of await retainedTestWorktrees(repository))
      await removeTestWorktree(repository, checkout);
    await rm(target, { recursive: true, force: true });
    repositories.delete(repository);
  }
}
