export interface CheckScoreInput {
  readonly id: string;
  readonly status: "passed" | "failed";
}

export interface Score {
  readonly passed: number;
  readonly total: number;
  readonly ratio: number | null;
}

export function scoreChecks(checks: readonly CheckScoreInput[]): Score {
  const passed = checks.filter(({ status }) => status === "passed").length;
  return {
    passed,
    total: checks.length,
    ratio: checks.length === 0 ? null : passed / checks.length,
  };
}
