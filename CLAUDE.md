# Architecture
Read `ARCHITECTURE.md` before writing any game code. It sets the sim and UI boundary, the game-loop
and state rules, the folder layout, and the anti-slop gates. Follow it.

Read `CONTEXT.md` for the domain vocabulary. The build plan lives in the GitHub issues and the ADRs under `docs/adr/`.

# Ticketing
This project uses Github issues

# Headless scenario check

`pnpm sim:run` runs a scenario through the real engine with no browser and no UI. It
writes sim.json, findings.json, and summary.json, and exits 0 only when detection is
clean (zero missed attacks, zero false alerts).

Use it as an end-to-end check whenever you build or change a scenario or an engine rule.
Run the scenario in wave mode and confirm a clean verdict before you open a PR:

    pnpm sim:run -- --scenario <id> --mode wave --seed 1

The automated suite runs this same utility end-to-end (scripts/sim-run.e2e.test.ts), so a
regression in the shipped detection fails CI.
