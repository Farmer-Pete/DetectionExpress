# Detection Express

The game ships with a finished detection Engine that runs against a rising stream of sensor readings from a train station. The player watches it run clean, then causes chaos: more attackers, new sensors, new reading formats, new threats. The Engine strains under the rising pressure, and the game is watching it hold.

The player observes the station watch. They do not stop anyone at the gate, and they do not build the Engine to progress. They watch readings arrive from the station's sensors, watch the Engine spot the pattern that marks an intruder, and watch it raise the alarm.

## Language

### Core

**Engine**:
The player-built system that detects threats in the reading stream. Its structure is general, but the theme stays the train station.
_Avoid_: Pipeline (a Pipeline is one part of an Engine), machine, program.

**Algorithm**:
The processing approach the player designs. The Pipeline and its Rules realize it. The player improves the Engine by rewriting the Algorithm, not by buying upgrades.
_Avoid_: Solution, logic, strategy, build.

**Pipeline**:
The wired graph of Nodes inside an Engine. Events flow through it from ingest to output.
_Avoid_: Flow, chain, graph.

**Node**:
One component in a Pipeline with tunable parameters. Some Nodes hold small player-authored Rules.
_Avoid_: Block, box, stage, module.

**Rule**:
Player-authored logic inside a Node. The player writes it in a compact scripting language. Some Nodes also use SQL to fetch data.
_Avoid_: Query, filter, logic, code.

**Event**:
One sensor reading entering the Engine. It is flat and typed. Its schema depends on its Endpoint.
_Avoid_: Record, message, log, item, signal.

**Endpoint**:
A sensor at the station, such as an account kiosk, a fare gate, a door reader, or a platform camera. Each Endpoint emits its own reading format. Adding Endpoints is a main way the game grows harder.
_Avoid_: Source, feed, input, device.

**Alert**:
An object the Engine raises when the Algorithm decides a pattern is an Attack. It names a reason, a time, and the Events it cites. One correct Alert per Attack raises Correctness. A wrong or duplicate Alert lowers it.
_Avoid_: Detection, hit, notification, flag.

**Threat**:
An Event that is part of a real Attack. On its own it can look like an ordinary reading. The Attack is the pattern across its Threats.
_Avoid_: signal, bad event.

**Attack**:
A real intrusion hidden in the stream, such as someone guessing a PIN at the account kiosk. It is one or more Threats on an account inside a time span. A Hunt defines the pattern that reveals it. The Engine should raise one Alert per Attack. Catching it raises Correctness. Missing it lowers it.
_Avoid_: breach, incident, wave.

**Ground truth**:
The hidden knowledge of which Events form the real Attacks in a run. The game holds it in the scorer, apart from the Events the Algorithm sees. The player does not see it. The code is open, so we do not obfuscate it.
_Avoid_: Answer, label, key, tag.

**Backlog**:
Events waiting because the Engine cannot process them fast enough. Too much Backlog ends the run.
_Avoid_: Queue depth, lag, buffer.

**SLA**:
The service level the player must hold. Meeting it earns Income. Falling behind on Throughput or Correctness cuts Income.
_Avoid_: Contract, target, goal.

### Play structure

**Scenario**:
One playable level. It runs in real time and can be lost. Each Scenario raises the pressure with more Endpoints, new data formats, new Hunts, or new Vulnerabilities.
_Avoid_: Level, stage, mission, map.

**Hunt**:
A detection objective the player must satisfy. It describes a Threat pattern to catch in the stream. A new Hunt can force the Algorithm to change shape.
_Avoid_: Rule, mission, quest, task.

**Vulnerability**:
A weakness in a monitored system that the player must detect before an attacker exploits it. A common target of a Hunt.
_Avoid_: Bug, flaw, hole.

### Pressure

**Resource**:
One of four competing measures the player must hold: Throughput, Correctness, Cost, Flexibility.
_Avoid_: Stat, metric, meter.

**Throughput**:
How well the Engine keeps up with the incoming event rate. Falling behind grows the Backlog.
_Avoid_: Speed, performance, rate.

**Correctness**:
How well the Engine produces the right outcomes. Missed Attacks and false Alerts both lower it.
_Avoid_: Accuracy, quality.

**Cost**:
The economy that funds the Engine. Income arrives over the run. Building Nodes spends it. Each Node also has a running cost. When the money runs low, the player cannot adapt, and the other Resources collapse.
_Avoid_: Money, price, budget.

**Flexibility**:
How easily the current Algorithm absorbs a new Hunt, Vulnerability, or Endpoint. A tightly tuned Algorithm runs fast but resists change. The game shows no gauge for it. A new demand reveals it, and a rigid Algorithm forces a costly rewrite.
_Avoid_: Adaptability, extensibility, agility.

**Data scaling**:
The performance ramp. Event volume and burst size climb. New Endpoints add new data formats to handle.
_Avoid_: Load, traffic.

**Feature request**:
The architecture disruptor. A new Hunt or Vulnerability the player must detect. It can invalidate the current Engine design.
_Avoid_: Task, requirement, ticket, feature.

**Failure**:
A lost Scenario. It happens when a Resource crosses a hard limit. Too much Backlog or too many Correctness mistakes ends the run.
_Avoid_: Game over, death, loss.

### Optimization

**Optimization**:
A technique the player applies inside the Algorithm to raise Throughput or lower Cost. Examples: memoization, aggregation, batching, caching, indexing, windowing, parallelism, deduplication. The player writes an Optimization as a construct in a Node's Rule script. Optimizations are shared, not bound to one Node. Each Optimization has a Side effect that can break Correctness if the player ignores it.
_Avoid_: Tool, Upgrade, lever, power-up, buff.

**Side effect**:
The correctness risk an Optimization introduces. Example: a cache can serve a stale answer. The player must handle it or pay in Correctness.
_Avoid_: Bug, drawback, penalty.

**Stress event**:
A surge in the stream that exposes an unhandled Side effect. Examples: a burst of kiosk readings, a late reading, a duplicate tap, two gate readers racing to report the same card. It turns a hidden flaw into a visible Correctness drop.
_Avoid_: Attack, wave, test, spike.
