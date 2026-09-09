import { isAbsolute, relative, resolve, sep } from "node:path";

export function resolveInside(root: string, requestedPath: string): string {
  const target = resolve(root, requestedPath);
  const relation = relative(resolve(root), target);
  if (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) &&
      relation !== ".." &&
      !isAbsolute(relation))
  ) {
    return target;
  }
  throw new Error(`Path escapes the disposable worktree: ${requestedPath}`);
}
