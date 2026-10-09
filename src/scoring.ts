export interface CheckScoreInput {
  readonly id: string;
  readonly status: "passed" | "failed" | "skipped";
}

export interface Score {
  readonly version: "2";
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly total: number;
  readonly ratio: number | null;
}

export function scoreChecks(checks: readonly CheckScoreInput[]): Score {
  const passed = checks.filter(({ status }) => status === "passed").length;
  return {
    version: "2",
    passed,
    failed: checks.filter(({ status }) => status === "failed").length,
    skipped: checks.filter(({ status }) => status === "skipped").length,
    total: checks.length,
    ratio: checks.length === 0 ? null : passed / checks.length,
  };
}
