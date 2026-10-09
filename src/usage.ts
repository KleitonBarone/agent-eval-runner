import { Type, type Static, type TSchema } from "@sinclair/typebox";

function metricSchema<T extends TSchema>(valueSchema: T) {
  return Type.Union([
    Type.Object(
      {
        status: Type.Literal("known"),
        source: Type.Union([
          Type.Literal("measured"),
          Type.Literal("not_applicable"),
        ]),
        value: valueSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        status: Type.Literal("unknown"),
        reason: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  ]);
}

export const TokenUsageSchema = metricSchema(Type.Integer({ minimum: 0 }));
export const CostUsageSchema = metricSchema(Type.Number({ minimum: 0 }));
export const UsageSchema = Type.Object(
  {
    modelTokens: TokenUsageSchema,
    modelCostUsd: CostUsageSchema,
  },
  { additionalProperties: false },
);

export type Usage = Static<typeof UsageSchema>;
export type UsageMetric = Static<typeof CostUsageSchema>;

export function fakeUsage(): Usage {
  return {
    modelTokens: { status: "known", source: "not_applicable", value: 0 },
    modelCostUsd: { status: "known", source: "not_applicable", value: 0 },
  };
}

export function totalMetric(metrics: readonly UsageMetric[]): UsageMetric {
  if (metrics.some(({ status }) => status === "unknown")) {
    return {
      status: "unknown",
      reason: "At least one attempt has unknown usage",
    };
  }
  let total = 0;
  let source: "measured" | "not_applicable" = "not_applicable";
  for (const metric of metrics) {
    if (metric.status === "known") {
      total += metric.value;
      if (metric.source === "measured") source = "measured";
    }
  }
  return { status: "known", source, value: total };
}
