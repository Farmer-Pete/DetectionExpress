# The Detection Express world

This folder documents the world the game is set in: the metro network, its sensors, the
vendors who build those sensors, and the 30 hunts (scenarios) the player works through. The world
data itself no longer lives here as JSON — it is four typed TS modules under `src/`, `as const
satisfies` their type, imported at build time. `assertWorldConsistent` checks the world module's
referential and graph invariants once at load, and `src/game/world-data-integrity.test.ts` checks
the cross-references between all four modules. So this data is live and enforced, not just
reference (see ADR-0011). The `src/sim/` scenarios stay the source of truth for what a run
actually plays.

## The files

Each data file is a typed TS module: the compiler owns its structural shape (field presence,
primitive types, literal unions), so a malformed edit fails `tsc`, not just a test run. The JSON
Schemas that used to sit beside these files as editor hints are gone — a schema cannot attach to
a `.ts` file, and the shape they described now lives in the type itself.

| Data | Type | Holds |
| --- | --- | --- |
| `src/sim/world/world.data.ts` | `World` (`src/sim/world/world.ts`) | Trust zones, lines, stations, staff sites, the control center. |
| `src/game/sensors.data.ts` | `SensorData` (`src/game/sensor.types.ts`) | Each sensor, where it sits, its clean shape, and its per-vendor raw shapes. |
| `src/game/manufacturers.data.ts` | `ManufacturerData` (`src/game/sensor.types.ts`) | The five vendors and how their data reads. |
| `src/game/scenarios.data.ts` | `CatalogueData` (`src/game/catalogue.types.ts`) | All 30 hunts, sorted easiest to hardest. |

## How they connect

The files reference each other by id. Descriptive text lives in one place only. The
sensor-to-vendor link is the one relationship stored in both directions: `sensors.data.ts` names
the `manufacturerId` on each sensor, and `manufacturers.data.ts` names the sensor ids in each
vendor's `makes`. Adding a sensor means editing both sides, so keep them in sync.
`world-data-integrity.test.ts` enforces this pair, the scenario-to-sensor link, and the
`foundAt`-to-world link — a broken cross-reference fails that test, not just a schema hint.

```text
 scenarios.data.ts ── sensors[] ──▶ sensors.data.ts ── manufacturerId ──▶ manufacturers.data.ts
 │                                  │
 └── (reads the map) ──▶ world.data.ts ◀── foundAt.zones / stations / sites ──┘
```

- A scenario names the sensor ids it reads. Look them up in `sensors.data.ts`.
- A sensor names the manufacturer ids that build it. Look them up in `manufacturers.data.ts`.
- Zones, stations, and sites named anywhere resolve against `world.data.ts`.

## Two ideas worth knowing before you read

**A zone is trust, not distance.** A zone is a layer of access, from Z0 (the public concourse)
up to Z4 (the control floor). Every site stacks several zones. Crossing up a level should cost
more proof. This is the metro stand-in for network segmentation, so a badge that lands in a high
zone without crossing the lower ones is the same idea as a segmentation break.

**The normalization pain is on purpose.** Every sensor reports one clean internal shape, shown
as `normalizedExample`. But each vendor spells its raw payload differently: `WRONG_PIN` versus
`declined` plus a reason, ISO time versus epoch milliseconds, romaji keys versus SCREAMING_SNAKE.
That gap is the work the player's Normalize Rule exists to close.

## Difficulty maps to the logic shape

The star rating tracks the detection logic shape, which is what makes a Rule easy or hard to
write. `scenarios.data.ts` carries the full scale. In short: one star is a count in a window, and
five stars is a per-entity baseline you have to learn and tune.

## Honesty notes

- The MITRE ATT&CK ids are verified for the enterprise hunts. Two that came back at lower
  confidence in research are now settled: `T1621` (Multi-Factor Authentication Request Generation)
  is correct for Knock Flood, and Quiet Handover cites `T1078` for the login plus `T1098` for the
  follow-on account change.
- The three operational hunts (Ghost Train, Phantom Signal, Runaway Cadence) belong to ATT&CK for
  ICS, not enterprise ATT&CK. They link to the ICS matrix rather than a specific technique id,
  because the research pass did not pin those ids.
- The vendors, station names, and quirks are invented for the game. Any resemblance to a real
  transit operator or product is a coincidence.
