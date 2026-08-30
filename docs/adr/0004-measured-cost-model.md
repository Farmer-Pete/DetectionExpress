# ADR 0004 — Measure the player's code, do not count operations

- Status: Accepted
- Date: 2026-08-28

## Context

Slice 2 puts the player under load: waves of Events climb, and a slow Rule has to fall
behind. For that pressure to be real, the engine has to know how much work a player's Rule
does per Event. It cannot read that from the game Clock. A synchronous `match()` fires no
tick, so the Clock reads the same value before and after the call. Wall-clock time is banned
in the sim (ARCHITECTURE.md rule 8) and is not deterministic anyway.

The game's whole point is that the player writes real code with real libraries. A Rule may
parse strings, pull in lodash by URL, or fold in a stats helper. Any cost model that prices
only one blessed engine operation is blind to all of that, and it would teach the wrong
lesson about where cost comes from.

## Decision

Measure the player's code throughput off the sim, then feed the sim a single fixed cost.

- A profiler runs the player's code over a fixed corpus built from the level seed at peak
  density. It times three things in one pass: the player's code — both `normalize` and `match`,
  since a player can put heavy work in either (`C = events/playerMs`) — a detection-shaped anchor
  (`A = events/anchorMs`, the fixed normalize plus the naive scan over the same corpus), and a
  stable integer oracle (`O`, kept only as profiler-health metadata).
- It stores `codePerAnchor = C / A = anchorMs / playerMs`, a machine-independent code speed.
  The oracle and the player's code both scale with machine speed, so the ratio cancels it out.
- Before the run, the engine quantizes the rate to a rational: `serviceRate = (C/A) * OMEGA`,
  fixed to `num/den` with a constant denominator, reduced by its gcd. This runs entirely in
  integer arithmetic, so the governor has no float drift.
- **The run-time cost is a constant per rule.** The profiler returns one number, and the sim
  charges that same service time for every Event for the whole run. The naive Rule's real
  per-Event cost actually grows with the window it scans, so we measure it at peak density,
  its worst case, and charge that constant.
- **So the squeeze is rising arrival against a fixed rate,** not a per-Event charge that
  climbs during the run. Waves raise the arrival rate; the service rate stays put; a slow rate
  floods and a fast one keeps up.

The measurement runs in a warmed Web Worker, with a main-thread fallback where a module Worker
cannot be constructed. All wall-clock reads live in the profiler, never in the sim loop.

The Compute gauge shows `1 / serviceRate`, the ticks each Event costs for the current Rule. It
is flat per Rule: the naive default reads high, the Optimization reads low, and applying the
Optimization drops it.

The naive default the player starts with is the **per-account re-filter**: it keeps each
account's recent fails and re-filters that account's window on every fail. It is the realistic
detector a player writes first, and it drowns with margin (about 20 records/tick measured
against a 60/tick peak). It is not a flat scan over the whole log; an earlier draft framed it
that way to make cost grow during the run, and the constant-service model above makes that
framing unnecessary.

## The boundary the sim enforces

The run does not end when the Event stream ends. It ends on a **checkpoint** schedule derived
from the waves, and the last checkpoint is the **final deadline**.

- At each checkpoint the engine settles pending misses (`scorer.advanceTo`), then reads
  the queue (`admitted - completed`) and Correctness. A non-zero queue fails the run with reason
  `queue`. Correctness below the floor fails it with reason `correctness`.
- The final deadline catches a naive Rule that would otherwise drain slowly after the last
  wave. The Clock stays live until the deadline even after the end-of-stream marker drains, so
  a slow Rule still fails there and a fast one wins.

## Alternatives weighed

**A counted-operation proxy.** Charge a fixed cost per Event the Rule reads from an engine
store. It is deterministic and needs no wall-clock, which is genuinely appealing. We rejected
it as the run-time model: it prices one blessed operation and is blind to string parsing, an
imported library, or later enrichment, so it would misteach the architecture the game is built
to reward. The counted model still lives on, but only as the offline winnability band test
(a pure, deterministic CI check that both Rules run through the real channels and sleep math,
across a band of `OMEGA` and a resource-skew factor, and that the naive Rule fails with margin
while the Optimization clears every checkpoint with margin).

## Consequences

This is the honest trade at the casual-game bar. We took it on purpose; these are its known
limits (GH3-PLAN.md section 11).

- **Cross-machine determinism is relaxed.** A seed is not the exact same challenge on a fast
  box and a slow box. Per-machine replay still holds, because the service rate is fixed before
  the run starts. A future "ship a fixed number with the seed" tournament mode could restore a
  shared challenge; it is not needed for this slice.
- **Resource-mix skew.** The anchor is array-and-garbage shaped but not identical to every
  player's code. Worst case is about 1.3x to 2x, phone versus desktop. The band margin absorbs
  it, and because both Rules are measured on the same machine, their ratio survives.
- **JIT warmth.** A short profile could measure faster than a short run. This slice raises
  volume hard, so the run warms up too; the profiler discards a warm-up stretch and matches the
  run's call count, and the waves are ordered low to high.
- **Normalize and match are both priced.** The profiler times the player's `normalize` and `match`
  together, so heavy work in either is reflected in the measured rate — charged once at the Match
  node, since the single service rate already accounts for both. The anchor's fixed `normalize` is
  the baseline both rules are measured against; a player `normalize` of a very different shape falls
  under the resource-mix-skew limit above, not a blind spot.
- **Winnability is a band, not a proof.** We cannot prove a runtime on unknown hardware. We
  prove the separation ratio holds across a parameter band with margin. That is the honest
  guarantee here.
