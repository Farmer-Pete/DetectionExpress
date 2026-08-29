# Manual smoke: local-IDE hot-reload (M2b)

The real hot-reload loop rides Vite's HMR channel and a module Worker (the profiler).
`happy-dom` cannot run either, and the loop was already validated by the two throwaway
prototypes (86-PLAN.md "Prototype results"), so there is no automated browser test here.
All the client and plugin logic is covered by the fake-channel unit tests:

- `algorithms-resolve.test.ts` — slug validation, active-file resolution, framing, the
  monotonic version counter.
- `algorithms-dev-client.test.ts` — bootstrap `algo:hello`, applying a matching
  `algo:changed`, foreign-slug drop, stale-generation drop after stop/re-subscribe,
  enter/stop snapshot-and-restore, forced-reload resume from `sessionStorage`.

Run this smoke by hand after any change to `algorithms-hmr.ts`,
`algorithms-dev-client.ts`, or the App wiring.

## Steps

1. `pnpm run dev` (the normal Vite dev server; `PUBLIC_DEV_KIT` unset). The
   `detection-express:algorithms-hmr` plugin loads on `apply: "serve"`.
2. Open the app. The run starts on the in-game editor source (source mode).
3. Click **Edit in IDE**. The in-game editor locks. The client sends `algo:hello`; the
   plugin replies `algo:changed` with the default engine path (no override yet), so the
   run switches to url mode on `/src/game/default-engine.ts` with no page reload.
4. Create `src/algorithms/kiosk-pin-attack.ts` (a copy of `default-engine.ts` is a good
   start). The plugin re-resolves the slug to the new override and pings it; the run
   re-imports the override with no reload.
5. Edit `match` in that file and save. The run updates on every save — fresh code, no full
   page reload. The profiler re-measures the new module (Chrome or Firefox).
6. Save a syntax error. The run reports a **load** error with no reload. Fix it; the run
   recovers cleanly on the next save.
7. Delete `src/algorithms/kiosk-pin-attack.ts`. Vite forces ONE full page reload
   (an imported module vanished — accepted degradation). After the reload the page
   re-enters local mode from `sessionStorage`, falls back to the default engine, and the
   in-game editor stays locked.
8. Click **Stop editing**. The in-game editor unlocks and its original text is restored
   (through the `sessionStorage` snapshot), and the run returns to source mode.

## What to watch for

- No full page reload on an edit or a compile error (only on a delete of the active file).
- The in-game editor text after **Stop editing** is exactly what it was before **Edit in
  IDE**, even across the forced reload in step 7.
- A change to an algorithm file for a slug you are not editing changes nothing.
