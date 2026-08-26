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

2. **Fixed timestep for the sim. requestAnimationFrame for render.** Step the sim by a constant delta. Drain an accumulator each frame. Clamp the max steps per frame to avoid the "spiral of death". Pause the accumulator when the tab hides.

3. **Each tick publishes one atomic snapshot.** The sim writes a single immutable snapshot per tick. React never reads half-updated state.

4. **React subscribes through an external store.** Read the snapshot with `useSyncExternalStore` or a store like Zustand. Never hold fast-changing sim state in `useState`. That re-renders the tree every tick.

5. **Throttle the UI.** Push snapshots to the HUD at about 10 to 30 Hz, even when the sim ticks faster. The eye does not need 60 Hz gauges.

6. **The graph is the single source of topology.** The player edits nodes and edges in the store. The sim reads that graph as its wiring. Do not copy the graph into a second sim-only structure. Two truths drift apart.

7. **No ECS.** For dozens of Nodes and Events, plain typed modules with arrays and maps win. Revisit only if entity counts reach the thousands.

## Testing

- Test the sim as pure functions. It needs no DOM. It runs in the Vitest `sim` project (Node).
- Make the sim deterministic. Use a seeded RNG and a fake clock. Snapshot sim state at tick N.
- Test React parts in the Vitest `ui` project (jsdom) with Testing Library.

## React Flow

- React Flow (`@xyflow/react`) lands in Slice 0, not before.
- Keep it controlled. Nodes and edges live in the store, not in component state.
- Every change to the `nodes` array re-renders dependent components. So memoize custom nodes. Use store selectors to feed live data into one node without re-rendering the whole graph.

## Anti-slop

- Biome is the linter and formatter. The `biome-anti-slop` GritQL rules live in `tools/biome/anti-slop/`. They reject low-evidence TypeScript.
- TypeScript runs at maximum strictness.
- Knip flags dead code and unused dependencies.
- These gates run on pre-commit, pre-push, and in CI.
