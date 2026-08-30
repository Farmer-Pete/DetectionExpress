# ADR 0009 — Ship a finished Engine, observe then perturb

- Status: Accepted
- Date: 2026-08-30

## Context

The game used to ask the player to build the detection engine, level by level. The
player wrote the Rules, wired the Pipeline, and grew the Engine to survive each new
Scenario. The onboarding matched that frame: a "you are hired as a Detection
Engineer" letter, and per-hunt briefings written in the "you write the rule" voice.

That frame no longer holds. The game now ships with a finished detection engine that
Peter wrote. The player does not build it. The player watches it run against a
modeled metro, then causes chaos and watches it hold under pressure. The engine is the
demonstration, not the exercise.

The old voice is now wrong wherever it survives. It tells the player to do work the
game no longer asks of them.

## Decision

Ship a finished engine. Frame the whole game as observe, then perturb.

- **The engine is done.** The player reads the running engine. They do not author
  its Rules to progress. The in-browser editor stays, so a curious player can still
  read and change the engine, but progression no longer depends on it.
- **The player observes, then causes chaos.** The first move is to watch the engine
  run clean. The next is to raise the pressure and watch it hold. The chaos ladder is
  the honest map of that rising pressure: five levels, only Level 1 playable today.
- **The metro is modeled, and the copy says so in the present tense.** Every rider,
  fare tap, door, and camera is modeled. Peter holds the ship until the model is
  complete, so the present-tense claim stays true at ship.

## Consequences

- **Onboarding voice changes.** The hire letter becomes an intro that introduces the
  simulation, invites the player to observe then perturb, and points at the source
  and the editor. A Hire Me surface carries Peter's pitch, since the whole game is a
  live demo of his work.
- **The 30 hunts' framing changes.** Each hunt is no longer a task the player builds
  a Rule for. It is a form of chaos the finished engine answers. This ticket rewords
  only the one live scenario (`kiosk-pin-attack`). A follow-up ticket rewrites all 30
  per-hunt briefings, reading from `docs/world/scenarios.json`.
- **The `ChaosLevel.playable` flag is a seam.** Today the ladder is prose. When the
  chaos runner lands, the flag grows into real level selection.

## Voice guide for the per-hunt rewrite

The later rewrite of all 30 briefings should follow this voice. It is the same voice
used for the `kiosk-pin-attack` briefing in this ticket.

- Name the chaos first. Say what the attack is in plain words.
- Then say how the engine answers it. Describe the engine at work: it reads the raw
  events, normalizes them, counts, and raises one alarm per burst.
- Keep the real facts. State the exact pattern (five wrong PINs in five minutes) and
  the exact response (one alarm per burst, not one per event).
- Write the engine as done. Present tense. The engine holds its speed under pressure.
- Do not ask the player to write a Rule, hire them, or hand them a task. They watch.
- Plain words. Short sentences. Active voice. No hype. One idea per line.
