# Detection Express

A real-time detection game set in a train station. The game ships a finished detection
engine and runs it against a rising stream of sensor readings; the player watches it hold
as new sensors, data formats, and threats arrive. A curious player can rewrite the engine,
but progression does not depend on that.

## Docs

- `CONTEXT.md` — the domain vocabulary.
- The build plan lives in the GitHub issues and the ADRs under `docs/adr/`.
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

## Rewrite the engine (optional)

The game ships one finished engine, composed from the scenario rules. Progression never
needs you to touch it, but if you want to, open the Algorithm tab of the side panel. It
holds the assembled JavaScript engine as editable text. Edit it and press Apply: a failed
edit shows its error in the panel and leaves the running engine untouched.
