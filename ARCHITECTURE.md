# Architecture

This file sets the rules for how the code is shaped. Read it before you write game code.
`CONTEXT.md` holds the domain vocabulary. This file holds the boundaries.

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
| `src/ui/`   | React components, gauges, the inspector shell, the findings panel. | Yes.              |

## Inside `src/ui/`

There is no `widgets/` or `components/` folder. "Widget" is a narrow domain term for the
four `Finding.context` renderers in `src/ui/findings/widgets.tsx`. The real convention:

- **One feature folder per concern.** `intro/`, `decisions/`, `hud/`, `sidepanel/`.
- **A presentational component, paired with a controller hook.** `Foo.tsx` renders. A
  `use-foo.ts(x)` hook owns its state, effects, and lifecycle. A hook that returns JSX
  is a `.tsx` file, like `use-intro-overlay.tsx`. A hook may return the ready-to-mount
  node itself, so the caller drops it straight into the tree instead of assembling it.
- **Pure display logic goes in a DOM-free `view-model.ts`.** No React, no DOM reads, so
  it tests as a plain function (`src/ui/findings/view-model.ts`,
  `src/ui/decisions/view-model.ts`).
- **One narrow `useGameStore` selector per value.** Never a fat selector that reads
  several fields at once. Each call names one value: `useGameStore((state) => state.x)`.
- **Props carry cross-component wiring the store cannot express.** A focus-restore ref,
  a callback the parent owns. Optional props are typed `?: T | undefined`, not `?: T`,
  for `exactOptionalPropertyTypes`.
- **All CSS lives in the global `src/index.css`.** No CSS modules, no styled-components,
  no per-component stylesheets.
- **Tests sit next to the code they test and use React Testing Library.** They assert
  accessible roles and text, not implementation detail.

`src/ui/sidepanel/` and `src/ui/intro/` follow this exactly: a presentational component
(`SidePanel.tsx`, `IntroOverlay.tsx`), a controller hook that returns the mounted node
(`use-side-panel.tsx`, `use-intro-overlay.tsx`), and co-located tests for both.

## The rules

1. **The sim owns the loop. React never drives it.** The loop lives in a plain-TS module in `src/game/`. A `useEffect` starts and stops it. Render never ticks the sim.

2. **The sim is a real-time async pipeline driven by one Clock.** Nodes are async tasks. Events flow over a `Channel` between nodes, with backpressure. One Clock owns time, pause, and stop, and every wait goes through it. (Part 0 note: the Sink uses a short `sleep` to fake a slow node. That sleep is temporary. It goes away once players write their own node code, and the pipeline stays async but becomes deterministic.)

3. **A sampler publishes one atomic snapshot.** A 10 to 30 Hz sampler reads the running pipeline and writes a single immutable snapshot. React never reads half-updated state.

4. **React subscribes through an external store.** Read the snapshot with `useSyncExternalStore` or a store like Zustand. Never hold fast-changing sim state in `useState`. That re-renders the tree every tick.

5. **Throttle the UI.** Push snapshots to the HUD at about 10 to 30 Hz, even when the sim ticks faster. The eye does not need 60 Hz gauges.

6. **The topology is a fixed constant the engine reads.** The chain lives as sim-shaped values in `src/game/topology.ts`, and `getGraph()` maps them to the wiring the sim reads. The player edits the Rule, not the graph. Do not copy the topology into a second sim-only structure. Two truths drift apart.

7. **No ECS.** For dozens of Nodes and Events, plain typed modules with arrays and maps win. Revisit only if entity counts reach the thousands.

8. **Game clock only.** Time is the game Clock's ticks. The sim and the scorer use game-time values only (Clock ticks, scheduled Event timestamps, a processed watermark). Never use wall-clock time (`Date.now`, `performance.now`, `setInterval` durations) in sim or scoring logic. Render animations may pace with `requestAnimationFrame`, but never feed wall time back into the sim.

   **The one measured cost lives outside the sim (Slice 2).** The engine must know how much
   work a player's Rule does per Event, and it cannot read that from the game Clock: a
   synchronous `detect()` fires no tick, so `now()` reads the same before and after it. So a
   profiler measures the player's code throughput off the sim, normalizes it against a
   detection-shaped anchor (`C/A`), and quantizes it to a fixed rational service rate. That
   rate is the only cost the sim consumes, and it stays constant for the whole run. The
   measurement runs in a Web Worker, with a main-thread fallback where a module Worker cannot
   be constructed. Every wall-clock read (`performance.now`) lives in that profiler. The sim
   loop still holds no wall-clock.

   The trade: cross-machine determinism is relaxed. A seed is not the exact same challenge on
   a fast box and a slow box, because the service rate is measured per machine. Per-machine
   replay still holds, because the rate is fixed before the run starts. See
   `docs/adr/0004-measured-cost-model.md` for the decision and its limits.

   ```
     edit time (Web Worker, off the sim)        run time (sim loop, game ticks)
       measure C/A, quantize serviceRate   -->    charge a fixed cost per Event
       performance.now lives here                 no wall-clock; ticks only
   ```

9. **Validate at seams; trust types inside.** Runtime guards belong where a bad value
   could loop forever, corrupt determinism, or arrive as a caller-supplied number at a
   module seam: `admitArrivals` rejects rates that would stall its accumulator, the
   scheduler rejects bad horizons and non-advancing reschedules, the PIN attacker
   rejects malformed timestamps. Internal call sites covered by the strict type system
   carry no redundant runtime checks. A new guard must name the failure mode it
   prevents; a missing guard must have a type that already prevents it.

## Folders for content

- `src/sim/endpoints/` holds reusable Endpoints. Each family keeps one internal record type and the actor cast emits it; each Endpoint is a thin formatter over it. Pure logic, no React. Endpoints are shared across Scenarios.
- `src/sim/actors/` holds the shared generation machinery (the FSM engine, the scheduler, the composer, the wave admission controller) and the benign actors every Scenario reuses (the rider, the account rider, staff, trains). Pure logic, no React. **Graduation rule:** a deviant or specialized actor is born in its Scenario's own folder (e.g. `pin-attacker.ts` under `pin-brute-force/`), and graduates into `src/sim/actors/` only when a second Scenario casts it — until then it stays local, so `src/sim/actors/` holds only what is genuinely shared.
- `src/sim/scenarios/` holds one folder per Scenario. A Scenario builds its actor cast, drives the intent timeline, injects Attacks as deviant actors, and records the Ground truth. Pure logic, no React.
- The player's Algorithm is an ES module the engine imports at runtime. A run controller in `src/game/` owns its edit, load, and reload lifecycle.
- One composed engine detects every registered hunt, authored as many files: a core plus one rule per scenario, composed by `createEngine`. The in-game editor shows one assembled JS module, built from those files and served as a Vite virtual module (`virtual:engine-source`). A player edits that text and presses Apply, in the Algorithm tab of the side panel. See `docs/adr/0010-one-engine-composable-scenarios.md`.

## Toolchain

- **Node** (26.5.1, pinned in `.nvmrc` and CI) is the runtime. **pnpm** (10.29.3) is the
  package manager, with a 7-day install cooldown in `pnpm-workspace.yaml`.
- **Vite** is the only dev server and the bundler. Dev server: `pnpm run dev`. Build:
  `pnpm run build` (to `dist`). Vite bundles the profiler Web Worker and serves it over
  http. `verify:static` checks the production build: it carries the assembled engine and
  is non-vacuous.
- **Vitest** (happy-dom) is the test runner; **tsx** runs the TypeScript scripts.
- See `docs/adr/0005-node-toolchain-drop-bun.md` for the move to Node, and
  `docs/adr/0001-all-bun-drop-vite.md` (Superseded) for the Bun era it reverses.

## Testing

- The test runner is `vitest` (happy-dom environment; see `vitest.config.ts`).
- Test the transforms, the `Channel`, and the rate math as pure functions. They need no DOM.
- Keep real time out of the tests. Give the Sink an injectable delay, not a real clock. Drive the `Channel` by hand and assert on counts and rates.
- Test React parts with `@testing-library/react`. happy-dom provides the DOM.

## Anti-slop

- Biome is the linter and formatter. The `biome-anti-slop` GritQL rules live in `tools/biome/anti-slop/`. They reject low-evidence TypeScript.
- TypeScript runs at maximum strictness.
- Knip flags dead code and unused dependencies.
- These gates run on pre-commit, pre-push, and in CI.
