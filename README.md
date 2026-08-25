# Agent Eval Runner

Agent Eval Runner will compare coding-agent attempts against the same repository and task under reproducible conditions.

Each run will preserve the patch, commands, test results, duration, token use, and cost. Deterministic checks will decide whether the result works before an optional model-based review considers code quality.

> Status: planning. There is no working release yet. See the [roadmap](ROADMAP.md) for the intended build order.

## Why build this?

Agent demos often show one successful run and hide the failures. That makes it hard to compare models, prompts, tools, or repository instructions. This project will treat reproducibility and inspectable evidence as the product.

The first release will support:

- A versioned task specification
- Isolated runs against a fixed Git revision
- Captured patches, commands, logs, and artifacts
- Time, token, and cost budgets
- Deterministic test and lint checks
- Side-by-side reports across attempts

## Design position

A test result is stronger evidence than another model's opinion. Model-based judging may add context later, but it will never replace deterministic checks or hide the underlying artifacts.

The first release will run locally against disposable worktrees or containers. A hosted execution platform and an agent marketplace are out of scope.

## License

[MIT](LICENSE)
