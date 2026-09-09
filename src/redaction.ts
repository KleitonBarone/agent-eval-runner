const ASSIGNMENT_PATTERN =
  /\b((?:api[_-]?key|token|secret|password|passwd|credential)s?)\s*=\s*([^\s"']+)/giu;
const BEARER_PATTERN = /(\bAuthorization\s*:\s*Bearer\s+)([^\s]+)/giu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type Redactor = (value: string) => string;

export function createRedactor(secretValues: readonly string[]): Redactor {
  const secrets = [
    ...new Set(secretValues.filter((value) => value.length >= 4)),
  ].sort((left, right) => right.length - left.length);

  return (value) => {
    let redacted = value;
    for (const secret of secrets) {
      redacted = redacted.replace(
        new RegExp(escapeRegExp(secret), "gu"),
        "[REDACTED]",
      );
    }
    return redacted
      .replace(BEARER_PATTERN, "$1[REDACTED]")
      .replace(ASSIGNMENT_PATTERN, "$1=[REDACTED]");
  };
}

export function collectTaskSecrets(task: TaskSpec): string[] {
  const values: string[] = [];
  const collect = (env: Readonly<Record<string, string>> | undefined): void => {
    if (env === undefined) return;
    for (const [key, value] of Object.entries(env)) {
      if (/(?:key|token|secret|password|passwd|credential)/iu.test(key))
        values.push(value);
    }
  };

  for (const action of task.adapter.actions) {
    if (action.kind === "runCommand") collect(action.env);
  }
  for (const check of task.checks) collect(check.env);
  return values;
}
import type { TaskSpec } from "./spec.js";
