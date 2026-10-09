import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
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
  await execFileAsync("git", [
    "-C",
    repositoryPath,
    "worktree",
    "remove",
    "--force",
    worktreePath,
  ]);
}

export async function retainedTestWorktrees(
  repositoryPath: string,
): Promise<string[]> {
  const { stdout } = await execFileAsync("git", [
    "-C",
    repositoryPath,
    "worktree",
    "list",
    "--porcelain",
  ]);
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter(
      (path) =>
        resolve(path).toLowerCase() !== resolve(repositoryPath).toLowerCase(),
    );
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
    await rm(target, { recursive: true, force: true });
    repositories.delete(repository);
  }
}
