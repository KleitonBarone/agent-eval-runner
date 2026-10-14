# Roadmap

The project has been reset to a basic TypeScript scaffold. This replaces the old
runner and isolation roadmap; previous implementations remain in Git history.

Keep the first useful release small: three owned exercises, deterministic
checks and local models. No third-party repository benchmark is planned.

## 0. Basic setup

- [x] Strict TypeScript, Node.js and pinned pnpm
- [x] Formatting, linting, type checking and a build command
- [x] Linux and Windows CI for those checks
- [x] Documentation that states the scaffold has no evaluator yet

There is deliberately no placeholder test suite or evaluation command.

## 1. Three owned exercises

- [ ] Choose three short coding exercises suitable for lightweight models
- [ ] Keep prompts, starter files and deterministic checks inside this project
- [ ] Define a small exercise interface so another simple task can be added
- [ ] Add focused tests for correct answers, incorrect answers and edge cases

Acceptance: all three exercises have verified reference solutions and reject
known incorrect solutions, without external repositories or model calls.

## 2. One local evaluation

- [ ] Define versioned JSON task and result formats
- [ ] Add a deterministic fake adapter for development
- [ ] Record output, check results, score and failures in one result file
- [ ] Enforce external time and output limits
- [ ] Choose and document a disposable, offline execution boundary before
      running generated code

Acceptance: one documented command completes a fake-agent evaluation against
an owned exercise and produces a reproducible score. Failure and timeout cases
produce usable results rather than disappearing.

## 3. A lightweight local model

- [ ] Choose one local runtime and small model explicitly
- [ ] Add one adapter without broadening the exercise interface
- [ ] Record model identity, prompts, configuration and measured duration
- [ ] Run the three exercises with deterministic scoring and external budgets
- [ ] Document what is reproducible and what remains environment-dependent

Acceptance: a bounded local run attempts all three exercises, preserves failed
attempts and produces a machine-readable summary. Downloads require explicit
approval; no paid or cloud calls are part of this path.

## Deferred

Batch scheduling, resume, dashboards, hosted workers, provider credentials,
third-party repositories and advanced quota/private-daemon profiles are not
requirements for this rebuild. Add them only after a concrete need appears.
