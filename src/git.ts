import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(
  repository: string,
  args: readonly string[],
): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

export interface PreparedCheckout {
  readonly sourcePath: string;
  readonly path: string;
  readonly revision: string;
}

export async function prepareCheckout(
  sourcePath: string,
  requestedRevision: string,
): Promise<PreparedCheckout> {
  const source = resolve(sourcePath);
  const revision = (
    await git(source, [
      "rev-parse",
      "--verify",
      `${requestedRevision}^{commit}`,
    ])
  ).trim();
  if (revision.toLowerCase() !== requestedRevision.toLowerCase()) {
    throw new Error(
      `Git revision did not resolve exactly to ${requestedRevision}`,
    );
  }

  const worktreePath = await mkdtemp(join(tmpdir(), "agent-eval-worktree-"));
  await git(source, ["worktree", "add", "--detach", worktreePath, revision]);
  return { sourcePath: source, path: worktreePath, revision };
}

export async function capturePatch(checkoutPath: string): Promise<string> {
  const untracked = await git(checkoutPath, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const paths = untracked.split("\0").filter((path) => path.length > 0);
  if (paths.length > 0)
    await git(checkoutPath, ["add", "--intent-to-add", "--", ...paths]);
  return git(checkoutPath, [
    "diff",
    "--binary",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "HEAD",
    "--",
  ]);
}

export async function removeCheckout(
  checkout: PreparedCheckout,
): Promise<void> {
  const tempRoot = resolve(tmpdir());
  const target = resolve(checkout.path);
  const relation = relative(tempRoot, target);
  if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new Error(
      `Refusing to remove worktree outside the temporary directory: ${target}`,
    );
  }
  await git(checkout.sourcePath, ["worktree", "remove", "--force", target]);
}
