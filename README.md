# Detection Express

A real-time detection game set in a train station. The player builds a detection engine,
runs it against a rising stream of sensor readings, and keeps re-architecting it as new
sensors, data formats, and threats arrive.

## Docs

- `CONTEXT.md` — the domain vocabulary.
- `PLAN.md` — the build plan, sliced from Slice 0 to Slice 6.
- `ARCHITECTURE.md` — the sim and UI boundary. Read it before writing game code.

## Stack

TypeScript and React on a Node toolchain: Node 26.5.1 runtime, pnpm as the package
manager, Vite as the dev server and bundler, Vitest as the test runner. The sim is
plain TypeScript. See `docs/adr/0005-node-toolchain-drop-bun.md` for the toolchain
decision.

## Develop

```bash
pnpm install       # install dependencies and git hooks
pnpm run dev       # start the dev server
pnpm run test      # run the test suite
pnpm run typecheck # type-check the project
pnpm run lint      # Biome lint and format check (includes anti-slop rules)
pnpm run format    # apply Biome fixes
pnpm run knip      # find dead code and unused dependencies
pnpm run build     # production build
```
