# The Detection Express world

This folder documents the world the game is set in: the metro network, its sensors, the
vendors who build those sensors, and the 30 hunts (scenarios) the player works through. It is
design reference, not runtime code. The `src/sim/` scenarios stay the source of truth for what
actually runs.

## The files

Each data file has its own JSON Schema. The data file points at its schema through `$schema`,
so an editor can validate it as you type.

| Data | Schema | Holds |
| --- | --- | --- |
| `world.json` | `world.schema.json` | Trust zones, lines, stations, staff sites, the control center. |
| `sensors.json` | `sensors.schema.json` | Each sensor, where it sits, its clean shape, and its per-vendor raw shapes. |
| `manufacturers.json` | `manufacturers.schema.json` | The five vendors and how their data reads. |
| `scenarios.json` | `scenarios.schema.json` | All 30 hunts, sorted easiest to hardest. |

## How they connect

The files reference each other by id. Nothing is duplicated across files.

```
 scenarios.json ── sensors[] ──▶ sensors.json ── manufacturerId ──▶ manufacturers.json
        │                             │
        └── (reads the map) ──▶ world.json ◀── foundAt.zones / stations / sites ──┘
```

- A scenario names the sensor ids it reads. Look them up in `sensors.json`.
- A sensor names the manufacturer ids that build it. Look them up in `manufacturers.json`.
- Zones, stations, and sites named anywhere resolve against `world.json`.

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
write. `scenarios.json` carries the full scale. In short: one star is a count in a window, and
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
