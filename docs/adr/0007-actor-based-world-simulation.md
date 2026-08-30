# ADR 0007 - Generate all telemetry with an actor-based world simulation

- Status: Accepted
- Date: 2026-08-29

## Context

The player's Engine reads sensor telemetry. The game has to generate that telemetry. So far one
scenario does it. The kiosk-pin-attack scenario rolls each event's fields from a seeded RNG,
plants one attack per wave, and fills the rest with benign successes. That works because a kiosk
reading is a flat, near-independent record.

The epic needs much more. Nine sensors, five vendors, and thirty hunts. Their readings are not
independent fields. Each reading is a snapshot of a person or a train moving through the world
over time. Roll the fields at random and you break the ties between them.

Concrete breaks we hit while planning ticket #30:

- A fare card's balance is a running total. Roll it per event and it drifts up between two taps,
  which never happens to a real card.
- A card is one physical object. Roll its station per event and the same card taps two far
  stations seconds apart, which is the exact pattern the impossible-travel hunt looks for.
- A badge opens doors up to its grade. Roll the door per event and a benign badge lands in the
  control room without crossing the floors below it, which is the privilege-jump pattern.

Each break turns benign traffic into a false attack. That destroys the one property every
scenario must hold. The kiosk scenario states it plainly: the stream is "always separable: any
scoring error is a bug in the Rule, not the data."

There is a second trap. A rider's behavior seems to depend on the trains, the trains on their
routes, the routes on the distances between stations. Model any one part and you seem forced to
model the whole metro. That regress is what stalls a naive design.

### What the research says

We ran two rounds of research into how this is done. The findings, kept here so we do not lose
them:

- Model the actor, not the fields. Agent-based modeling (ABM) represents each person as a small
  state machine with its own state and rules. Physical and temporal limits then hold per actor.
  One actor cannot be in two places at once, and its balance cannot rise on its own.
- The actor-versus-environment split is the tool that breaks the regress. Not everything is an
  actor. The station map, the distances, and a train timetable are environment. An actor reads
  the environment. The environment never asks a question back up the chain. Production transport
  models work this way. MATSim and TRANSIMS load the network, and often the timetable, as fixed
  supply, and simulate only the travelers.
- Model only what a pattern needs. Pattern-oriented modeling and the KISS principle say to build
  the simplest model that reproduces the target patterns, and to add structure only when a
  pattern demands it.
- Build a benign baseline, then inject labeled bad. Detection-testing practice generates normal
  traffic first, then splices in a few labeled malicious events as ground truth. This is the same
  shape the scorer already expects: benign events plus a separate list of attacks.
- Keep it reproducible. Use one seeded PRNG. Derive each actor's stream from it. Fix the order in
  which actors act from the seed, not from iteration order.
- Document with ODD, validate by eye and by pattern.

No off-the-shelf library fits. AgentScript is GPL-3.0, which we cannot ship in a bundled browser
app. trip-simulator is Node-only and needs a native road-graph engine. Discrete-event and
statechart libraries add a dependency, duplicate the Clock we already own, and know nothing about
fares, taps, or door grades. So we hand-roll a small model in TypeScript on the seeded RNG and
faker we already ship.

This decision sets how every scenario generates data, for all thirty hunts. It is recorded here
before the content tickets build on it. This revision also validates that every piece of
`docs/world/` has a place in the model. That check is the completeness map below.

## Decision

Generate every sensor's telemetry from an actor-based simulation, written in TypeScript.

1. Actors are deterministic state machines. A rider, a staff member, a train, a dispatcher, a
   network host. Each holds its own state and a guarded transition function.
2. The environment is read-only, immutable data. The station map, the distances, the door grades,
   the timetable, and the reference lists a hunt reads. Actors read it. It never reads back and it
   never changes during a run. Anything with running state, including a door that opens and closes,
   is an actor, not environment.
3. A scheduler owns game time. It advances an integer game tick and activates actors in a fixed,
   seed-derived order. It never reads wall-clock time, per ARCHITECTURE rule 8.
4. An actor emits an internal sensor reading as the side effect of a transition. A scenario
   composer formats that reading into a vendor wire payload and assigns it a `PipeEvent` id.
   Endpoints stay dumb formatters.
5. An attack is a deviant actor, or a coordinated attacker. A deviant actor is a normal actor with
   one guard removed or one identity shared. A coordinated attacker is one attacker that drives
   many credentials, such as a spray across accounts or a card-testing run at one machine. Both
   carry a ground-truth label. Benign actors keep their guards, so they cannot produce either
   pattern by accident.
6. Coherence holds by construction at two levels. Per actor, a guard makes an illegal state
   unreachable. Per credential, scenario assembly gives each card and badge exactly one owner, so
   one credential's whole stream stays coherent.

The whole model in one picture:

```text
   SEED (one integer)
     |
     v
   master mixer ---> per-actor seed = mix(runSeed, actorId) ---> one randomLcg per actor
     |
     v
   SCHEDULER  (integer game tick; order by (nextTick, seededPriority, actorId))
     |
     |  reads                                    emits on transition
     v                                                   |
   ENVIRONMENT (read-only)         ACTORS (state machines)|
     station map, distances  <------  rider  (account, card)   v
     door grades             <------  staff  (badge)     internal reading
     timetable               <------  train  (service)        |
     reference lists         <------  operator, host           |  composer: format() + assign id
        ^ never asks back            door object, gate observer v
        |                                                  PipeEvent (Gatekeep fare-gate, door-reader, ...)
        +---- benign baseline ----> INJECT deviant actors (labeled) ----> attacks[]
```

## The completeness map: every piece of the world, placed in the model

This section is the validation ticket #30 requires. It walks every file in `docs/world/` and
gives each element a home in the model. If a hunt did not fit, the model would have a gap. None
did.

### Every sensor is one actor's projection

| Sensor | Actor that produces it | What the actor does |
| --- | --- | --- |
| kiosk | Rider (account) | signs in, answers an MFA prompt, changes account settings |
| fare-gate | Rider (card) | taps in and out on a journey |
| tvm | Rider (card) | tops up, or takes a refund |
| door-reader | Staff (badge) | is granted or denied at a door |
| door-contact | Door object, driven by Staff or an attacker | opens and closes, or is forced or held |
| platform-camera | Gate observer over the crowd | counts grants against persons at a gate |
| train-tracker | Train (service) | arrives at and departs a station |
| occ-console | Operator | issues a command from a console |
| network-relay | Host | sends bytes to a destination |

Two of these are not people, but both are actors, because both hold running state. A `Door` is an
actor with an open or closed state that the scheduler owns. Its contact readings come from a staff
grant or an attacker's force. A `Gate observer` is an actor that reads the rider actors passing a
gate and counts them against the camera's person count. It is the one actor that observes other
actors, which is the single interaction the model has. Both fit the same tick-and-emit engine, and
neither lives in the immutable environment.

### Every vendor is a format, not an actor

`manufacturers.json` lists five vendors: gatekeep, veritap, railsense, sentinel, tetsudo. A vendor
is a wire dialect, not a behavior. Each sensor's endpoint gains one `format()` per vendor in that
vendor's `makes` list. The actor emits one internal reading. The endpoint formats it into the
chosen vendor's payload. So the vendor layer lives entirely in the dumb formatters, and a scenario
picks which vendors emit for a sensor when it wants the mixed-format difficulty.

### Every hunt is a deviant actor

All thirty hunts in `scenarios.json` are a deviation on one of the actors above. The benign actor
keeps its guards, so it never makes the pattern. The deviant actor breaks one rule.

| Hunt | Actor | The deviation |
| --- | --- | --- |
| PIN Brute Force | Rider (account) | one account, many failed sign-ins in a window |
| Revoked Pass | Rider (account) | signs in on an account in the revoked list |
| Master Key Sweep | Rider (account) | a few PINs across many accounts |
| Knock Flood | Rider (account) | a burst of MFA prompts to one account |
| Lazarus Card | Rider (account) | a sign-in after a long dormancy |
| Two Platforms at Once | Rider (account) | one account signs in at two far stations too fast |
| Quiet Handover | Rider (account) | an odd sign-in then an account change |
| Ghost Crowd | many Riders (account) | a network-wide failure spike hiding rare wins |
| Rapid Fire Tap | Rider (card) | one card taps a gate many times a minute |
| Broken Journey | Rider (card) | opens journeys and never closes them |
| Short-Change Journey | Rider (card) | a long ride paying a short fare |
| Rolling Clone | Rider (card) | one card id at two far stations too fast |
| Wormhole Transfer | Rider (card) | one pass opens far-apart journeys in the transfer window |
| Number Fishing | Rider (card) | one machine runs many distinct cards |
| Cashback Loop | Rider (card) | one card takes many refunds from one machine |
| Night Shift | Staff (badge) | a grant outside the badge's allowed hours |
| Rattling the Lock | Staff (badge) | one badge denied many times at one door |
| Skipped Checkpoint | Staff (badge) | a grant in a high zone with no lower crossings |
| Roaming Badge | Staff (badge) | one badge at two far sites too fast |
| Propped Gate | Door object | held open past its limit |
| Broken Seal | Door object + attacker | opens with no matching reader grant |
| Shadow Rider | Gate observer | more persons than grants at a gate |
| Ghost Train | Train | a movement with no scheduled service |
| Runaway Cadence | Train | two trains too close on one track |
| Phantom Signal | Operator | a command from an unauthorized source |
| Dispatcher Overreach | Operator | actions far past the operator's normal scope |
| Network Sweep | Host | one source touches many destinations |
| Freight Run | Host | one host sends far more bytes than its normal |
| Metronome | Host | steady, low-jitter calls to one destination |
| Convergence on Control | Host and Operator | a credential climbing zones toward the control center |

### What the map forces the model to hold

The walk above shows the model needs more than a map. The environment carries fixed reference data
only. Anything that changes during a run is state a train actor or the scorer owns, never
environment:

- Fare is a function of distance, not a flat charge. Short-Change Journey and Wormhole Transfer
  need a fare that should match the ride, so a short fare on a long ride reads as fraud.
- A revoked-account list, an authorized operator-and-console list, and a per-badge allowed-hours
  schedule. Revoked Pass, Phantom Signal, and Night Shift read these.
- A train timetable, which is fixed environment. Per-track occupancy is not stored. The train
  actors produce it at run time, and Ghost Train and Runaway Cadence read the resulting movements.
- Site-to-site distance, derived from each site's nearest station. Roaming Badge reads this.
- Per-actor baselines that emerge from the benign stream itself. Dispatcher Overreach and Ghost
  Crowd learn an operator's normal or a station's normal failure rate, then score the deviation.
  The model does not precompute these, and they are not environment. The benign stream produces
  them, and the hunt or the scorer learns them, which is the whole point of a five-star hunt.

The model supports all three: fixed reference lists in the environment, per-actor schedules and
scopes as actor state, and emergent baselines from the benign stream.

### Where full coverage needs more than one deviant actor

The map above places every hunt, but two kinds of hunt need more than a single deviant actor, and
honesty demands naming them here. They do not affect ticket #30, which builds only the rider path
and injects nothing. Each is a requirement the hunt's own ticket carries.

- Coordinated attacks. Master Key Sweep, Number Fishing, Ghost Crowd, and Convergence on Control
  are one attacker acting through many credentials or hosts. The model covers them with the
  coordinated attacker in decision 5, not a lone deviant actor. The benign side is still many
  independent actors, so the coordinated pattern stands out.

- Normalized-record extensions. Some hunts read fields the current `sensors.json` records do not
  carry yet. The kiosk record needs an event kind and a source, so Knock Flood can see MFA prompts,
  Quiet Handover can see an account change after a sign-in, and Master Key Sweep can group by
  source. The relay and console records need a shared credential and a zone, so Convergence on
  Control can follow one identity climbing toward the control center. These are schema additions the
  relevant hunt ticket makes, alongside its endpoint. They are listed here so the gap is on the
  record, not discovered late.

With the coordinated attacker and those named record extensions, every one of the thirty hunts has
a real mechanism in the model. Ticket #30 depends on none of it.

## The environment

The environment is the world the actors move through, held as read-only data.

- The station map, the lines, the zones, the sites, the control center, and the doors. These live
  in `docs/world/world.json`, which the sim imports at build time. `parseWorld` validates it.
- The distance table. The shortest travel time in minutes between any two stations, computed once
  from the `connections` graph. A rider reads it to ride a feasible duration. It lands in ticket
  #30, because benign coherence needs it. The impossible-travel hunt (#77) reads the same table
  later.
- The door grades. Each door guards a zone. The grade is that zone's trust level, 0 to 4.
- The timetable and the reference lists described in the completeness map. Each is fixed data that
  arrives with the hunt that reads it, not before. Learned baselines and per-track occupancy are
  not environment. They are run state the scorer or the train actors own.

`parseWorld` is the runtime authority on `world.json`, so it validates every referential and graph
invariant, not just the doors. It requires unique zone, line, station, site, and door ids. It
checks line membership both ways, so a station's `lines` and a line's `stations` agree. It checks
that every connection names a real neighbor and a real line, and that the named line contains both
endpoints. It treats a connection as an undirected edge and requires the reciprocal edge to carry
an equal weight, so `distanceMinutes` can be symmetric and finite. It rejects a non-positive travel
time between two distinct stations, and it proves the station graph is connected so no pair is
unreachable. It resolves every `site.nearestStation` and every `zonesPresent` zone, so the site
distances and the door grades the hunts read cannot dangle.

## The scheduler and determinism

The scheduler runs the generation. It is offline and deterministic, like the current
`generate(seed)`. It is not the live game pipeline.

The scheduler entry point takes everything it needs by name: `runActors({ actors, env, runSeed,
horizon })`. It owns a record per actor, `{ actor, rng, seededPriority, nextTick }`, so the actor
type stays small.

- Time is an integer game tick. There are `GAME_SECONDS_PER_TICK` game seconds in a tick (two
  today). A duration in minutes converts with `ceil(minutes * 60 / GAME_SECONDS_PER_TICK)`. An
  emitted event's `ts` is `tick * GAME_SECONDS_PER_TICK`, in the game-second domain the pipeline
  already uses.
- Each actor gets its own PRNG, built from the run seed and the actor id, so the construction is
  spelled out and cannot depend on order. The scheduler rejects duplicate actor ids up front,
  because two actors with one id would share a seed and lose the final tie-break. It hashes the
  string `"${runSeed}:${actorId}"` with a fixed 32-bit mixer (xmur3) into an unsigned 32-bit
  integer, then builds one `randomLcg` from it. The value is canonicalized to unsigned on purpose,
  because `randomLcg` folds its seed through `Math.abs(seed) | 0`, so a signed mixer would collapse
  `n` and `-n` into one stream. No actor draws from a shared stream, and no faker instance is
  shared.
- The scheduler orders due actors by `(nextTick, seededPriority, actorId)`. The seeded priority is
  drawn once from the actor's own stream when its record is built, then stored, so it is stable.
  Ties break from the seed, not from array order. Every reschedule sets a finite integer tick
  strictly greater than the current tick, or marks the actor dormant. So the run always makes
  progress and never loops on a tie.
- Time is the game clock only. No `Date.now`, no `performance.now`, per ARCHITECTURE rule 8.

## Coherence at two levels

Per actor, guards make an illegal state unreachable. A rider cannot exit before entering. A
rider's balance cannot rise except on a top-up. A staff grant cannot exceed the badge grade.

Per credential and across actors, scenario assembly holds the invariants a single actor cannot.

- One owner per credential. Each card belongs to exactly one rider, and each badge to exactly one
  staff member. So one card's whole tap stream is one coherent journey sequence, not two riders'
  streams interleaved into a false in-in-out-out.
- Traversal coherence for staff. A benign badge crosses zones in order, low to high, because the
  staff actor tracks its current zone and only steps to an adjacent one. Skipped Checkpoint is
  then a deviant staff actor that jumps a zone, which is exactly the segmentation break the hunt
  looks for. Without this, a benign grade-4 badge could reach the control floor with no lower
  crossing and read as an attack.
- Fare and balance are non-negative integers in whole currency units, matching the normalized
  fare-gate record in `sensors.json`, where a balance reads as `250`. No floats. The fare for a
  trip is a function of the ride distance. A tap-in charges the fare. The emitted balance is the
  balance after the charge. A rider that cannot afford the fare goes dormant rather than go
  negative. A vendor that reports cents, such as VeriTap, converts in its `format()`, so the
  internal unit stays whole.

Each scenario asserts these invariants over the whole benign stream, keyed by credential, before
it hands the run out. With guarded actors the assertion mostly confirms what construction
guarantees, which is a cheap and honest double check.

## The generation contract

A scenario's `generate(seed)` still returns a `GeneratedRun` of `{ events, attacks, checkpoints }`.
What changes is how it fills them, and one type has to generalize.

- The scenario builds the actor cast and the environment, runs the scheduler to the horizon, and a
  composer turns the emitted readings into sorted `PipeEvent`s with stable ids.
- The `Attack` ground-truth type is specialized today. It requires an `account` and describes a
  PIN burst. Door, badge, train, operator, and host attacks do not fit that. So the ground-truth
  side generalizes to a sensor-neutral shape: an `id`, a `reason`, the cited `eventIds`, and a
  generic subject and time window. This mirrors ADR-0006, which already made the player's findings
  generic and scores by `reason` and `eventIds`. That generalization is its own change, made by
  the first ticket that injects a non-kiosk attack. Ticket #30 injects no attack, so it returns
  `attacks: []` and does not touch the type.
- Benign volume rises across waves. This is the one open design problem, described next.

## Wave admission is an open problem

Today waves guarantee an exact per-tick arrival rate with a fractional accumulator. Actors emit
only at trip boundaries, so a raw head count gives a noisy rate that may drift from the schedule,
and an actor could emit during a drain gap and break a checkpoint.

So an actor-based scenario needs a wave admission controller, not just a population count. The
controller decides when to start actors, holds arrivals to a rate envelope per tick and per wave,
keeps the drain gaps silent if a checkpoint relies on draining, and decides whether an in-flight
trip may finish past its wave. The first multi-actor scenario builds it and re-runs the existing
winnability and performance-band tests against the generated traffic. Ticket #30 does not solve
this. It stops at one rider's coherent day and a small benign stream, before the wave schedule
becomes load-bearing.

**2026-08-30 (#89):** Resolved. The wave admission controller (`src/sim/actors/admission.ts`)
covers an arrivals-only envelope: `WAVE_RATES` bounds trips *started* per tick, reproducing the
kiosk fractional accumulator exactly, not total event volume. A gap is arrival-quiet, not
event-silent — a drain gap and even a later wave may still carry an in-flight trip's tap-out,
since a rider is never clamped mid-ride. The final deadline is data-derived, not read from the
governor or the wave math: it is the real last event's tick, plus one, plus `DRAIN_GAP_TICKS`, and
a guard test pins the contract (`admitted === completed === events.length` on a win) so an engine
change would fail loudly rather than drift silently. Checkpoints clear records already admitted and
completed so far, never a wave's full eventual count. See `src/sim/scenarios/fare-gate-rush/run.ts`
and GH89-PLAN.md.

## Anomaly injection

An attack is a deviant actor, added after the benign baseline. Each deviation is small and
labeled. The completeness map above lists the deviation for all thirty hunts. Because benign
actors keep their guards, none of them can produce these patterns, so the ground truth is exact.

## TypeScript implementation

- Each actor is a plain typed finite state machine. Its state is a discriminated union. Its
  transition is a function from state, its own RNG, and the environment to the next state and any
  emitted reading. Guards and actions are ordinary functions, checked by the compiler.
- We do not encode the machines as JSON. A machine is mostly behavior, and behavior is code. A
  JSON skeleton would split each machine across a data file and a code registry, joined by string
  names the compiler cannot check. The typed FSM keeps the whole machine in one place the compiler
  can see, rename, and prove exhaustive. `world.json` stays JSON because it is pure facts.
- The environment is imported data plus derived tables, all pure. `parseWorld` narrows and
  validates the imported JSON. `distanceTable` computes shortest paths once. `doorGrade` resolves
  a door to its zone's trust level.
- No new dependency. The seeded RNG (`d3-random`) and `@faker-js/faker` already ship, both
  seedable without touching global `Math.random`.

Planned module layout, grown over several tickets:

```text
   src/sim/world/       environment: parseWorld, distanceTable, doorGrade, timetable (later)
   src/sim/actors/      the FSM engine + scheduler, then rider, staff, train, operator, host
   src/sim/entities/    seeded id pools: card, badge, account, and so on
   src/sim/endpoints/   dumb formatters, one format() per vendor (unchanged shape)
   src/sim/scenarios/   compose actors + environment, inject deviants, assert separability
```

## Applying the ODD protocol (a subset)

We use a subset of ODD to keep the model documented. We name the concepts we model and mark the
rest as not modeled, rather than claim the full protocol.

- Overview. Purpose: generate coherent benign telemetry with injectable, labeled anomalies.
  Entities: the actors, the door object, the gate observer, and the environment above. Process and
  scheduling: the scheduler section above.
- Design concepts we model. Sensing: an actor reads only the environment and its own state.
  Stochasticity: one seeded stream per actor. Observation: the emitted readings and the ground
  truth. Objectives: an actor follows a daily schedule or shift.
- Design concepts we do not model yet. Interaction between actors is limited. A rider does not see
  another rider. The one interaction we plan is the gate observer reading the crowd, and later a
  train gating a rider. So a crowd is an aggregate the observer counts, not an emergent jam.
  Adaptation, learning, and prediction are not modeled. An actor follows fixed rules.
- Details. Initialization, input data (`world.json`), and the per-actor submodels live in each
  scenario and each actor module, plus that scenario's tests.

## Alternatives weighed

- Keep rolling fields at random. Rejected. It cannot hold the ties between a reading's fields, so
  benign traffic manufactures false attacks and the run stops being separable.
- Precompute scripted itineraries instead of a reusable scheduler. This is the strongest simpler
  competitor. For a cast that never interacts, a per-actor script of timed events would do, with
  no scheduler. We chose the scheduler because the cast does interact soon. The gate observer reads
  the rider actors at a gate, and a train will gate a rider's boarding. A shared tick and one actor
  reading another's state are what those need, so we pay for the scheduler once rather than rewrite
  scripts into it later. The environment stays immutable throughout. Only actor state changes, and
  the scheduler owns it.
- Use an ABM or simulation library. Rejected. AgentScript is GPL-3.0 and we ship a bundled browser
  app. trip-simulator is Node-only with native dependencies. discrete-sim and XState add a
  dependency, overlap the Clock we own, and do not know the fare and door domain.
- Encode the machines as JSON in `docs/world/`. Rejected. It splits each machine into a JSON
  skeleton and a code registry tied together by string names the compiler cannot check.
- Simulate trains to make riders coherent. Rejected for now by pattern-oriented modeling. A rider
  only needs a feasible ride duration, which the distance table gives. A train timetable is
  environment we add when a train hunt needs the train sensors.

## Consequences

- Endpoints stay dumb formatters, one `format()` per vendor. The coherence lives above them, in
  the actors and the scenario.
- Scenarios build actor casts, not field loops. The kiosk-pin-attack scenario keeps working as is.
  It moves onto an account-rider actor when a ticket next touches it, not before.
- The distance table moves earlier than the impossible-travel hunt. Benign coherence needs it, so
  ticket #30 builds it. Issue #77 adds only the hunt that reads it.
- The `Attack` ground-truth type generalizes when the first non-kiosk attack lands. Ticket #30
  does not trigger that.
- The fare model is distance-based, not flat, because two hunts depend on a fare that should match
  the ride.
- New modules appear under `src/sim/world/`, `src/sim/actors/`, and `src/sim/entities/`. Knip
  flags any export no test or scenario consumes, so each actor lands with the scenario or test
  that uses it, and helpers stay module-private until imported.
- Validation is by eye and by pattern. Each scenario shows a coherent baseline a human can read,
  then asserts separability per credential. The first milestone for ticket #30 is one rider's day,
  checked by hand.
- Ticket #30 implements only the first slice: the environment and the rider path. Ticket #87 (the
  follow-up) carries the staff and door path, the multi-actor wave composer, and the
  `GeneratedRun` integration. The remaining actors, train, operator, host, and the gate observer,
  arrive with the hunts that read their sensors.

## Research sources

- Agent-based model overview: https://en.wikipedia.org/wiki/Agent-based_model
- Agent-environment interaction (Sayama, ch. 19.3):
  https://math.libretexts.org/Bookshelves/Scientific_Computing_Simulations_and_Modeling/Introduction_to_the_Modeling_and_Analysis_of_Complex_Systems_(Sayama)/19%3A_AgentBased_Models/19.03%3A_Agent-Environment_Interaction
- FHWA agent-based transport modeling primer:
  https://www.fhwa.dot.gov/publications/research/ear/13054/005.cfm
- Pattern-oriented modeling (Grimm et al., Science 2005):
  https://www.science.org/doi/10.1126/science.1116681
- The ODD protocol, updated 2020 (JASSS 23(2):7): https://www.jasss.org/23/2/7.html
- Methods that support the validation of ABMs (JASSS 27(1):11): https://www.jasss.org/27/1/11.html
- Mesa on agent activation order:
  https://mesa.readthedocs.io/stable/tutorials/2_agent_activation.html
- Activity-based travel models: https://tfresource.org/topics/Activity_based_models.html
- Cisco Talos EvidenceForge, synthetic log generation research:
  https://github.com/Cisco-Talos/EvidenceForge/blob/main/docs/design/synthetic-log-generation-research.md
- Synthetic generation of trip data from smart-card records (Springer):
  https://link.springer.com/article/10.1007/s42421-023-00079-6
