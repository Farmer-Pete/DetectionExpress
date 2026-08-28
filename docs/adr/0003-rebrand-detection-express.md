# ADR 0003 — Rebrand to Detection Express

- Status: Accepted
- Date: 2026-08-28

## Context

The old name, Detection Dash, read as an arcade speed runner and said nothing about what
the game actually asks the player to do: build a detection engine. The domain underneath
is abstract (typed events, endpoints, windows, aggregation), and an abstract domain needs
a concrete world to live in, or the player never gets a foothold.

A train station gives every piece of the domain a physical body. An Event becomes a
reading a sensor took. A window becomes the station clock. A count becomes a guard's
tally. The player can picture all of it, which is more than the old fiction offered.

## Decision

Rename the game to Detection Express and adopt the train station as its theme.

- Event is a sensor reading from the station. The shape does not change: still a flat
  typed record.
- Endpoint is a sensor: an account kiosk, a fare gate, a door reader, a platform camera.
  Each sensor keeps emitting its own record format, exactly as an Endpoint already did.
- The player runs the station watch. They detect and alert. They do not block inline.
  A sensor only reports what it can check on the spot; the Engine turns those reports
  into a threat by finding the pattern across them.

None of this touches the mechanics. The Pipeline, the Nodes, the Rules, the scorer, and
every term in `CONTEXT.md` carry over unchanged. Only the fiction wrapped around them
changes, plus the one scenario whose wire format ships with the code today (see
Consequences).

## Consequences

The vocabulary survives untouched. Every term in `CONTEXT.md` keeps its name; only its
illustrative examples and its opening paragraph now speak in station terms instead of
security-log terms.

The one existing Endpoint family and its Scenario, previously `auth` /
`brute-force-login`, become the `kiosk` Endpoint and the `kiosk-pin-attack` Scenario. The
wire shape's outcome values move from `SUCCESS` / `FAILURE` to `OK` / `WRONG_PIN`, and the
source-IP field becomes a terminal id. This is the one behavior-visible change in the
rename; everything else is a name.

A future ticket may add an active, blocking Endpoint (a real turnstile that can refuse
someone), which would be new mechanics, not part of this rebrand. The other sensors and
hunts in the appendices below are design records only. Building them is future work.

## Appendix — Sensor catalog

| Sensor | Reads (Event fields) |
|--------|----------------------|
| Account kiosk | account ID, time, PIN result (pass or wrong PIN) |
| Fare gate reader | card ID, gate ID, location, time, result (pass or decline + reason), card serial and batch code |
| Door reader (staff, depot) | card ID, grade on card, door ID, door grade, time, result (open or deny) |
| Gate counter | gate ID, swipes per second, count per window |
| Platform camera | track ID, location, time |

Each sensor is an Endpoint with its own format. Adding sensors is a main way a Scenario
grows harder, matching the existing "adding Endpoints" pressure.

## Appendix — Hunt catalog

Each row is one detection the player must build. The sensor reads only a fact. The Engine
infers the threat. The false alarm always hits a real traveler, which ties Correctness to
a human cost.

| Hunt | Scene on the platform | What the sensor reads | Alert to issue | Right vs wrong |
|---------------|----------------------|----------------------|----------------|----------------|
| Brute force (X fails in Y min) | One person feeds wrong PIN after wrong PIN into the account kiosk | Account kiosk: account ID, time, wrong PIN | One alert per account over the reject limit in the window | **Right:** Catch a guesser before he opens the account. **Miss:** He guesses the PIN and drains the balance. **False alarm:** Lock out a commuter who mistyped |
| Impossible travel | One card taps at two stations across town, minutes apart | Two gate readers: card ID, gate location, time. Both taps valid | One alert on the card for impossible speed | **Right:** Flag a cloned card. **Miss:** Two riders share one account. **False alarm:** Flag a fast transfer you mismeasured |
| Recon scan | One person rattles every gate and door in a row | Many door readers: same card, many doors, mixed pass and deny | One alert on the card probing the doors | **Right:** Catch someone hunting an open door. **Miss:** He finds the broken gate and returns. **False alarm:** Flag a lost rider trying doors |
| Volumetric flood | A crowd slams one gate all at once | Gate counter: swipes per second | One alert on the gate for overload | **Right:** Spot a staged rush. **Miss:** A real actor slips in under the noise. **False alarm:** Choke a normal rush hour |
| Privilege jump | A coach card suddenly opens the staff-only door | Staff door reader: card ID, grade on card, door grade, open | One alert on the card whose grade jumped above its history | **Right:** Catch a re-encoded clearance. **Miss:** He reaches the control room. **False alarm:** Block a real promotion |
| Baseline anomaly | A daily regular enters the depot at 3am for the first time | Depot door reader: card ID, grade, door ID, time | One alert on the card breaking its own pattern | **Right:** Catch a stolen regular's card. **Miss:** The thief roams the depot. **False alarm:** Flag a worker on a new shift |
| Distributed forgery | Twenty riders tap in, all carrying one ticket batch | Gate readers: card serial and batch code. Many cards, one batch | One alert on the batch, not per card | **Right:** Break a forgery ring. **Miss:** The ring bleeds fares for weeks. **False alarm:** Void a real print run |
| Attack chain | Loiter, test gates, slip through, head to the yard | Camera, gate, yard door: one track ID across the steps in order | One alert on the actor once the sequence completes | **Right:** Stop sabotage before the yard. **Miss:** He reaches the trains. **False alarm:** Detain a lost passenger |
