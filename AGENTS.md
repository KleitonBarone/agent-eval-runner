# AGENTS.md

## Current scope

This repository is a strict TypeScript and pnpm scaffold. The evaluator, CLI,
adapters, schemas and exercise suite are not implemented. Read README.md and
ROADMAP.md before changing scope; do not carry forward old completion claims.

The intended first release uses three small, project-owned exercises and a
lightweight local model. Keep additions modular without building a general
benchmark platform.

## Boundaries

- Questions are read-only. Explain and offer a change before implementing it.
- Do not download models, call paid/cloud providers, clone third-party
  repositories or provision isolation resources without explicit approval.
- Do not execute model-generated code on the host. Define its disposable,
  offline execution boundary before adding execution.
- Never delete host data, prune unrelated Docker resources or alter system
  services as an incidental project setup step.
- Keep credentials and local evaluation results out of Git.

## Implementation

Use strict TypeScript and pnpm. Avoid `any`, unsafe assertions and casting
wrappers. The only source file is currently `src/index.ts`, an empty module;
do not describe its successful build as an evaluation.

Add focused tests with the first behaviour they verify. Do not add no-op test
scripts or restore the old isolation framework just to satisfy a checklist.

## Verification

```sh
pnpm install --frozen-lockfile
pnpm format
pnpm check
pnpm build
```

`pnpm check` verifies formatting, linting and types. There is no test or example
command yet. Keep these commands, CI and README.md consistent when adding one.
Update roadmap checkboxes only after their acceptance criteria actually pass.
