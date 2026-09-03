# Detection Express

An interactive metro simulation that uses rail networks and bad actors to introduce the concepts of cybersecurity, detections, and threat hunting.

The whole transit network is simulated in real time: riders tap fare cards, doors open and shut,
cameras count bodies, trains move between stations. Watching over it is a finished
detection engine that reads the entire sensor stream and flags the attackers hiding in
ordinary traffic.

You don't have to just watch. Detection Express is also a place to practice writing an
engine. You normalize noisy ingest and write detections that catch the attack.

## For developers

Detection Express is built to be taken apart.

- **Ingest practice.** Every sensor speaks a different wire format. Five vendors, each with
  its own keys, timestamps, and encodings: SCREAMING_SNAKE, camelCase, terse numeric codes,
  romaji field names. The engine normalizes all of them into one event shape. Read how it
  does it, or change it.
- **Detection practice.** 30 scenarios, from a single brute-forced PIN to network-wide
  credential stuffing, most grounded in a real MITRE ATT&CK technique. Write a rule that
  catches the attack and leaves the benign traffic alone.
- **Rewrite the engine live.** Click Edit Engine in the app. The side panel holds the
  assembled JavaScript engine as editable text. Edit it and press Apply. A failed edit
  shows its error in the panel and leaves the running engine untouched.
- **Score it headless.** Run any scenario through the real engine with no browser and no UI:

  ```bash
  pnpm sim:run -- --scenario <id> --mode wave --seed 1
  ```

  It writes `sim.json`, `findings.json`, and `summary.json`, and exits 0 only when detection
  is clean: zero missed attacks, zero false alerts. The test suite runs this same path, so a
  regression in the shipped detection fails CI.

## Docs

- `CONTEXT.md` — the domain vocabulary.
- `ARCHITECTURE.md` — the sim and UI boundary. Read it before writing code.
- The build plan lives in the GitHub issues and the ADRs under `docs/adr/`.

## Stack

TypeScript and React on a Node toolchain: Node 26.5.1 runtime, pnpm as the package
manager, Vite as the dev server and bundler, Vitest as the test runner. The simulation is
plain TypeScript with no DOM, so it runs and tests without a browser. See
`docs/adr/0005-node-toolchain-drop-bun.md` for the toolchain decision.

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
pnpm sim:run       # run a scenario headless and score detection
```
