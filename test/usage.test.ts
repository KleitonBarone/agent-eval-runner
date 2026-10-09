import { describe, expect, it } from "vitest";

import { fakeUsage, totalMetric } from "../src/usage.js";

describe("usage normalization", () => {
  it("records fake model usage as known zero, not missing data", () => {
    expect(fakeUsage()).toEqual({
      modelTokens: { status: "known", source: "not_applicable", value: 0 },
      modelCostUsd: { status: "known", source: "not_applicable", value: 0 },
    });
  });
  it("propagates unknown values rather than turning them into zero", () => {
    expect(
      totalMetric([
        { status: "known", source: "measured", value: 5 },
        { status: "unknown", reason: "not reported" },
      ]),
    ).toMatchObject({ status: "unknown" });
    expect(
      totalMetric([
        { status: "known", source: "measured", value: 3 },
        { status: "known", source: "measured", value: 7 },
      ]),
    ).toEqual({ status: "known", source: "measured", value: 10 });
  });
});
