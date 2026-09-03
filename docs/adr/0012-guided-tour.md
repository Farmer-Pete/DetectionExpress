# ADR 0012 - A guided spotlight tour replaces the intro modal

- Status: Proposed
- Date: 2026-09-03

## Context

A new player's first screen is the intro modal (`src/ui/intro/`, extracted in GH109). It
is a real dialog: a premise paragraph, two action buttons, and two links. It makes the app
shell `inert` while it shows. The "How this works" topbar button reopens it.

The modal tells, but it does not show. It describes the simulation in prose while the actual
map, the sensor log, and the findings panel sit hidden behind a dim scrim. A player reads
about the game, dismisses the modal, and then has to find each part alone.

We want to teach the UI in place. Point at the real map, the real log, the real findings,
one at a time, with a short explanation beside each. This is a guided tour.

A tour is the opposite of a modal. A modal blocks the shell. A tour highlights live elements
and dims the rest. So it cannot reuse the `ModalHost` inert-shell pattern.

## Decision

Build the tour on **driver.js** (1.8.0), and remove the intro modal.

We compared five libraries. driver.js fits a project that values few dependencies, strong
accessibility, and TypeScript.

| Library | License | Runtime deps | Gzip | Verdict |
| --- | --- | --- | --- | --- |
| driver.js 1.8.0 | MIT | 0 | ~5kb | Chosen |
| react-joyride 3.2.0 | MIT | 10 | ~25kb | Too heavy |
| @reactour/tour 3.8.0 | MIT | 3 | ~7kb | No `role="dialog"`, focus-lock off, 1yr publish gap |
| shepherd.js 15.3.0 | AGPL-3.0 + paid | 2 | mid | License blocks our use |
| intro.js 8.5.0 | AGPL-3.0 + paid | 0 | small | License blocks our use |

driver.js is framework-agnostic vanilla TypeScript. We drive it from a controller hook:
build the instance in an effect, destroy it on cleanup. Its popover carries `role="dialog"`,
moves focus inside on open, closes on Escape, and navigates on arrow keys. Its highlight
recomputes on scroll and resize, which is enough because our tour targets are static panels.

Supporting decisions:

- Import `driver.js/dist/driver.css` once at the entry, then theme the popover in
  `index.css`. This is one allowed exception to the "all CSS in `index.css`" rule. Inlining
  the vendor CSS would mean hand-maintaining it across upgrades.
- The tour is not a modal. It never feeds `modalOpen`, so the shell stays interactive and
  the sim keeps running behind the spotlight.
- The hamburger button opens the side panel directly (no popup menu). Chaos ladder and
  Algorithm are the panel's existing tabs; a new "Options" tab holds the Hide/Show metro view
  toggle and the tour button ("Retake tour"). This replaces the standalone "How this works"
  topbar button.
- Persist a fresh localStorage key `detection-express:tour-seen`. Past players who dismissed
  the old intro still see the new tour once.

## Consequences

- One new runtime dependency, about 5kb gzipped, zero transitive deps. Security-review it
  before merge.
- One vendor CSS import, against the global-CSS rule. Recorded here on purpose.
- `App.tsx` gets simpler. The intro overlay, the `introOpen` term in `modalOpen`, and the
  whole intro-to-side-panel transition machinery (`pendingPanelTabRef`, `onRequestPanel`,
  the effect) all go away.
- The tour runs with `disableActiveInteraction: true`. It is narrated: the player watches and
  clicks Next. So a spotlighted control cannot be activated, and no step can open a modal that
  fights driver's focus trap or the `ModalHost` inert shell.
- The "cause chaos" tour step spotlights the hamburger button and narrates that it opens the
  panel. The tour does not open the side panel (a modal) while it runs, so there is no
  menu-during-tour focus conflict to manage.
- The tour is StrictMode-safe: `hasSeenTour()` is a lazy-initializer read, the `drive()` runs
  in an effect via a cancellable deferred task, and the seen-flag is written from `onDestroyed`
  with a cleanup-only suppression flag so a teardown is never marked seen.
- A new `ui/tour/` feature folder, following the project pattern: a controller hook, data,
  and co-located tests. The side panel gains an "Options" tab; no separate menu component.
