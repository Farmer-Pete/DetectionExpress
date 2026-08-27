# Architecture

This file sets the rules for how the code is shaped. Read it before you write game code.
`CONTEXT.md` holds the domain vocabulary. `PLAN.md` holds the build plan. This file holds the boundaries.

## The core split

The simulation is pure TypeScript. The UI is React. They never blur together.

```
   Player input                          Live snapshot (10-30 Hz)
        │                                          ▲
        ▼                                          │
   ┌─────────┐        reads topology        ┌──────────────┐
   │  ui/    │ ───────────────────────────► │   sim/       │
   │ React   │                              │  pure TS     │
   │         │ ◄─────── snapshot ────────── │  no DOM      │
   └─────────┘                              └──────────────┘
        ▲                                          ▲
        │                 game/                    │
        └──────── glue: run loop + store ──────────┘
```

## Folders

| Folder      | Holds                                                        | May import React? |
| ----------- | ----------------------------------------------------------- | ----------------- |
| `src/sim/`  | The Engine, Events, Rules, the tick. Pure logic.            | No. Never.        |
| `src/game/` | The glue: the run loop and the store that bridges sim to UI. | Only the store.   |
| `src/ui/`   | React components, gauges, panels, the React Flow canvas.     | Yes.              |

## The rules

1. **The sim owns the loop. React never drives it.** The loop lives in a plain-TS module in `src/game/`. A `useEffect` starts and stops it. Render never ticks the sim.

2. **The sim is a real-time async pipeline driven by one Clock.** Nodes are async tasks. Events flow over a `Channel` between nodes, with backpressure. One Clock owns time, pause, and stop, and every wait goes through it. (Part 0 note: the Sink uses a short `sleep` to fake a slow node. That sleep is temporary. It goes away once players write their own node code, and the pipeline stays async but becomes deterministic.)

3. **A sampler publishes one atomic snapshot.** A 10 to 30 Hz sampler reads the running pipeline and writes a single immutable snapshot. React never reads half-updated state.

4. **React subscribes through an external store.** Read the snapshot with `useSyncExternalStore` or a store like Zustand. Never hold fast-changing sim state in `useState`. That re-renders the tree every tick.

5. **Throttle the UI.** Push snapshots to the HUD at about 10 to 30 Hz, even when the sim ticks faster. The eye does not need 60 Hz gauges.

6. **The graph is the single source of topology.** The player edits nodes and edges in the store. The sim reads that graph as its wiring. Do not copy the graph into a second sim-only structure. Two truths drift apart.

7. **No ECS.** For dozens of Nodes and Events, plain typed modules with arrays and maps win. Revisit only if entity counts reach the thousands.

## Toolchain

- **Bun** is the whole toolchain: runtime, package manager, test runner, and bundler.
- Dev server: `bun ./index.html`. Production build: `bun build ./index.html`.
- We do not use Vite. See `docs/adr/0001-all-bun-drop-vite.md` for the decision and its reversal path.

## Testing

- The test runner is `bun test` (see `bunfig.toml` for the happy-dom preload).
- Test the transforms, the `Channel`, and the rate and heat math as pure functions. They need no DOM.
- Keep real time out of the tests. Give the Sink an injectable delay, not a real clock. Drive the `Channel` by hand and assert on counts, rates, and heat.
- Test React parts with `@testing-library/react`. happy-dom provides the DOM.

## React Flow

- React Flow (`@xyflow/react`) lands in Slice 0, not before.
- Keep it controlled. Nodes and edges live in the store, not in component state.
- Every change to the `nodes` array re-renders dependent components. So memoize custom nodes. Use store selectors to feed live data into one node without re-rendering the whole graph.

## Anti-slop

- Biome is the linter and formatter. The `biome-anti-slop` GritQL rules live in `tools/biome/anti-slop/`. They reject low-evidence TypeScript.
- TypeScript runs at maximum strictness.
- Knip flags dead code and unused dependencies.
- These gates run on pre-commit, pre-push, and in CI.
