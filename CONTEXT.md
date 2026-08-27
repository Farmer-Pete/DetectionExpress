# Detection Dash

A real-time cybersecurity game. The player builds a detection engine, runs it against a rising stream of security events, and keeps re-architecting it as new endpoints, data formats, and threats arrive. The engine strains, and the game is the ongoing adaptation.

## Language

### Core

**Engine**:
The player-built system that detects threats in the event stream. Its structure is general, but the theme stays cybersecurity.
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
One atomic record entering the Engine. It is a flat typed record. Its schema depends on its Endpoint.
_Avoid_: Record, message, log, item, signal.

**Endpoint**:
A monitored source of security telemetry, such as a host, a server, a firewall, or a cloud service. Each Endpoint emits its own data format. Adding Endpoints is a main way the game grows harder.
_Avoid_: Source, feed, input, device.

**Alert**:
An object the Engine raises when the Algorithm decides a pattern is an Attack. It names a reason, a time, and the Events it cites. One correct Alert per Attack raises Correctness. A wrong or duplicate Alert lowers it.
_Avoid_: Detection, hit, notification, flag.

**Threat**:
An Event that is part of a real Attack. On its own it can look ordinary. The Attack is the pattern across its Threats.
_Avoid_: signal, bad event.

**Attack**:
A real intrusion hidden in the stream. It is one or more Threats on an account inside a time span. A Hunt defines the pattern that reveals it. The Engine should raise one Alert per Attack. Catching it raises Correctness. Missing it lowers it.
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

**Tool**:
A technique the player applies inside the Algorithm to raise Throughput or lower Cost. Examples: memoization, aggregation, batching, caching, indexing, windowing, parallelism, deduplication. The player writes a Tool as a construct in a Node's Rule code. Tools are shared, not bound to one Node. Each Tool has a Side effect that can break Correctness if the player ignores it.
_Avoid_: Upgrade, lever, power-up, buff.

**Side effect**:
The correctness risk a Tool introduces. Example: a cache can serve a stale answer. The player must handle it or pay in Correctness.
_Avoid_: Bug, drawback, penalty.

**Stress event**:
A spike in the stream that exposes an unhandled Side effect. Examples: a burst, a late event, a duplicate, two racing writers. It turns a hidden flaw into a visible Correctness drop.
_Avoid_: Attack, wave, test, spike.
