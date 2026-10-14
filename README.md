# Agent Eval Runner

A strict TypeScript and pnpm scaffold for small, local coding-agent evaluations.
The evaluator has not been implemented in this reset.

The previous runner, adapters, schemas, isolation framework, examples and tests
have been removed. Their code remains in Git history.

## Development

Use Node.js 24.20.0 or newer and pnpm 11.23.0. CI uses Node.js 24.20.0 on Linux and
Windows.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

`pnpm check` verifies formatting, ESLint rules and strict TypeScript types.
`pnpm build` compiles `src` into `dist`. The source currently contains only an
empty module so the toolchain can be checked without inventing product behaviour.

Use `pnpm format` to format changes. There is no CLI, evaluation command or test
suite yet. Focused tests will accompany the first exercise implementation.

## Intended scope

The aim is three small, project-owned exercises suited to lightweight local
models, with deterministic checks and an easy way to add another exercise.
Versioned JSON inputs and results will make runs inspectable.

The scaffold does not download models, call providers, clone third-party
repositories or provision Docker resources. Generated-code execution and its
safety boundary must be designed before a model adapter is added.

See [ROADMAP.md](ROADMAP.md) for the new acceptance criteria. Earlier milestone
completion claims do not apply to this scaffold.

## License

[MIT](LICENSE)
