# Detection Dash

A real-time cybersecurity game. The player builds a detection engine, runs it against a rising
stream of security events, and keeps re-architecting it as new threats arrive.

## Docs

- `CONTEXT.md` — the domain vocabulary.
- `PLAN.md` — the build plan, sliced from Slice 0 to Slice 6.
- `ARCHITECTURE.md` — the sim and UI boundary. Read it before writing game code.

## Stack

TypeScript, React, and Vite. Bun is the runtime and package manager. The sim is plain TypeScript.

## Develop

```bash
bun install       # install dependencies and git hooks
bun run dev       # start the dev server
bun run test      # run the test suite
bun run typecheck # type-check the project
bun run lint      # Biome lint and format check (includes anti-slop rules)
bun run format    # apply Biome fixes
bun run knip      # find dead code and unused dependencies
bun run build     # production build
```
