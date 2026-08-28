# Detection Express — Development Plan

This plan delivers the vertical slice in small steps. Each slice is playable from Slice 1 on. Each slice tests one hypothesis about whether the game is fun. We stop and look after each one.

Read `CONTEXT.md` for the vocabulary. This file holds the plan, not the glossary.

## Setting and art

- Name: Detection Express.
- Theme: a train station, start to finish. The domain does not swap.
- Art: an arcade look. Neon, fast, and loud. Think a station departure board crossed with a coin-op cabinet.
- Feel: the clean systems diagram stays readable underneath. The arcade skin adds score pops, juice, and drama on top.
- Difficulty grows two ways. Add Endpoints with new data formats. Add new Hunts and Vulnerabilities to detect.

## Progress

- [ ] Slice 0 — Living stream
- [ ] Slice 1 — Catch the signal
- [ ] Slice 2 — Keep up
- [ ] Slice 3 — The squeeze
- [ ] Slice 4 — The twist
- [ ] Slice 5 — Adapt or die
- [ ] Slice 6 — One real scenario

Update a box to `[x]` when its slice meets its "done when" test.

## Principles

- We grow the node set. We add a node only when a slice needs it.
- Every slice from Slice 1 is playable. We can put it in front of someone and get a real reaction.
- Cost is a foundation. It arrives before the twist.
- The theme is the train station throughout. We grow difficulty with new Endpoints, new data formats, new Hunts, and new Vulnerabilities.
- The prototype is done after Slice 6. That is one polished scenario.
- Everything runs in the browser. Stack: TypeScript, React, and React Flow for the Pipeline. Plain TypeScript for the sim.

## The ladder

| Slice | Hypothesis it tests | New this slice |
|---|---|---|
| 0. Living stream | The tech feels alive in the browser | Ingest and Sink nodes. Throughput and Backlog gauges. |
| 1. Catch the signal | Writing a Rule to catch signals is satisfying | Parse and Match nodes. A Rule. Hidden Ground truth. Correctness gauge. |
| 2. Keep up | Rising volume creates real pressure to optimize | A data ramp. The first Tool. Hard-fail limits. |
| 3. The squeeze | Cost adds tension without fiddly busywork | The economy. SLA income. Build and running cost. |
| 4. The twist | The hidden Side effect is a fair "aha", not a cheap trick | A Stress event. It exposes the Tool's Side effect. |
| 5. Adapt or die | A Feature request forcing a rewrite is the best moment | The correlation request. Aggregate node and windows. Flexibility. |
| 6. One real scenario | The full loop holds together and reads well | Waves and calm. Win by survival. Polish. |

## Critical path

```
  0 ──► 1 ──► 2 ──► 3 ──► 4 ──► 5 ──► 6
  │     │     │     │     │     │     │
  tech  rule  speed cost  TWIST adapt scenario
                          (the heart)
  └──────── foundations ──────┘
```

The twist in Slice 4 is the make-or-break. Slices 0 through 3 lay the foundations that make the twist land. Slices 5 and 6 complete the picture.

## Slice detail

### Slice 0 — Living stream

- Goal: prove the real-time stream and node graph feel alive in the browser.
- In scope: Ingest node, Sink node, one wire. Events flow as marks. Throughput and Backlog gauges update live.
- Out of scope: rules, correctness, cost, failure.
- Done when: a viewer watches events flow and sees the Backlog grow when the Sink slows.

### Slice 1 — Catch the signal

- Goal: prove that writing a Rule to catch signals feels good and reads clearly.
- In scope: Parse and Match nodes. The player writes one Rule. Each Event carries hidden Ground truth. A Correctness gauge scores false negatives and false positives.
- Out of scope: data ramp, cost, tools.
- Done when: the player writes a Rule, watches Correctness respond, and tunes it.

### Slice 2 — Keep up

- Goal: prove that rising volume creates real pressure to optimize.
- In scope: a data ramp that raises the event rate. Backlog grows under load. The first Tool: an incremental scan that processes only new Events to cut work. Hard-fail limits on Backlog and Correctness.
- Out of scope: cost, the Side effect reveal.
- Note: the incremental scan quietly plants a Side effect. It skips late-arriving Events. We do not expose it yet.
- Done when: the player feels the squeeze, applies the Tool, and survives a higher rate.

### Slice 3 — The squeeze

- Goal: prove that Cost adds tension without fiddly busywork.
- In scope: the economy. SLA income arrives as the player keeps up. Building a Node costs money. Each Node has a running cost. Low money blocks adaptation.
- Out of scope: the twist, the Feature request.
- Done when: the player weighs a build against its running cost and feels the money squeeze.

### Slice 4 — The twist

- Goal: prove the hidden Side effect is a fair "aha", not a cheap trick.
- In scope: a Stress event. A late-arriving Event slips past the incremental scan from Slice 2. A true signal is missed. Correctness drops. The player must fix the Algorithm to handle lateness, not just tune a number.
- Out of scope: the Feature request.
- Done when: a tester hits the twist, understands why it happened, and fixes it with satisfaction.

### Slice 5 — Adapt or die

- Goal: prove a new Hunt forcing a rewrite is the best moment, not a wall.
- In scope: a new correlation Hunt. Example: alert only when a wrong PIN at the kiosk is followed by a valid tap from a new gate. The player adds an Aggregate node and a stateful window. Flexibility is revealed. A rigid Algorithm forces a costly rewrite.
- Out of scope: full polish.
- Done when: the player re-architects to serve the new Hunt and keeps the run alive.

### Slice 6 — One real scenario

- Goal: prove the full loop holds together and reads well to other people.
- In scope: the full station Scenario. Waves with calm windows. Win by surviving to the finish. Lose on Backlog overflow or Correctness collapse. The remaining nodes as the Scenario needs them. Visual and audio polish. A clean read of all four Resources.
- Out of scope: more Domains, endless mode, campaign progression.
- Done when: a new player finishes or loses one Scenario and understands why.

## After the prototype

Deferred by choice: more Endpoints and data formats, more Hunts and Vulnerabilities, harder waves, endless high-score mode, campaign progression, and cheat-proof scoring with seed and server verify.
