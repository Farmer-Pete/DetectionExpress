/**
 * The single source of the onboarding prose. This is UI copy, not simulation
 * logic, so it lives in `ui/`. It holds the intro overlay text, the Hire Me pitch,
 * the chaos ladder (levels 0 through 5, GH126-PLAN.md M3), and the source repo
 * link. No React. Each type is
 * consumed by a component through its props, so the values reach the screen and
 * Knip stays clean.
 *
 * The live scenario's briefing string is not here either. Display text comes
 * from the registry's catalogue join, the one source of it (GH42-PLAN.md
 * "Registry and catalogue metadata"): `Scenario` (the sim contract) carries no
 * briefing of its own, so there is nothing to drift against. The live scenario's
 * display name and tagline come from that same join, not from a hardcoded
 * singleton here: `liveScenarioFrom` below only shapes a joined
 * `ScenarioRegistryEntry` into the UI's `LiveScenario` view, at the one
 * chaos-ladder level today's single shipped hunt occupies.
 */
import type { ScenarioRegistryEntry } from "../../game/registry";

/** A ladder rung: one level of rising chaos. Used by the exported content types.
 *  0 is the calm baseline (no attack); 1 through 5 escalate (GH126-PLAN.md M3, Q3). */
type ChaosLevelNumber = 0 | 1 | 2 | 3 | 4 | 5;

/** The intro overlay copy: premise, invitation, and the action and link labels. */
export interface IntroCopy {
  title: string;
  paragraphs: string[];
  invitation: string;
  observeLabel: string;
  chaosLabel: string;
  sourceLabel: string;
  editLabel: string;
}

/** The Hire Me card copy: heading, body paragraphs, and the two contact links. */
export interface HireMeCopy {
  heading: string;
  body: string[];
  email: string;
  linkedin: string;
}

/** One rung of the chaos ladder. `playable` marks a level a player can run today. */
export interface ChaosLevel {
  level: ChaosLevelNumber;
  label: string;
  blurb: string;
  playable: boolean;
}

/** The one runtime scenario, in its ladder context. */
export interface LiveScenario {
  id: string;
  displayName: string;
  tagline: string;
  level: ChaosLevelNumber;
}

/** The source repository. The intro's "Get the source" link points here. */
export const REPO_URL = "https://github.com/Farmer-Pete/DetectionExpress";

export const introCopy: IntroCopy = {
  title: "Detection Express",
  paragraphs: [
    "This is a live simulation of a working metro. Riders tap fare cards, trigger door sensors, board and exit trains, even get spotted by cameras.",
    "Watching over it is a detection Engine that looks for attackers trying to abuse the system. It reads the whole stream of sensor data and finds threats hiding inside ordinary traffic.",
  ],
  invitation: "The simulation loads in a clean, steady state. It's your job to introduce chaos!",
  observeLabel: "Observe the simulation",
  chaosLabel: "Cause chaos",
  sourceLabel: "Get the source",
  editLabel: "Edit the Engine",
};

export const hireMe: HireMeCopy = {
  heading: "Hire me",
  body: [
    "Hello! 👋",
    "My name is Peter Naudus and I've spent 25 years building analytical and detection engines. If you have a ton of data and you need someone to ingest and process it, I'd love to chat!",
  ],
  email: "peter@naud.us",
  linkedin: "https://www.linkedin.com/in/linuxlefty/",
};

export const chaosLevels: readonly ChaosLevel[] = [
  {
    level: 0,
    label: "All good",
    blurb: "The metro runs in a clean, steady state. Enjoy it while it lasts.",
    playable: true,
  },
  {
    level: 1,
    label: "Uh oh",
    blurb: "A handful of bad actors fan out across the crowd. Good thing they are easy to detect.",
    playable: true,
  },
  {
    level: 2,
    label: "Welp, that's not good",
    blurb:
      "Oh, joy... in addition to the previous attackers, more attackers arrive. Plus some attackers are trying to hide their activity in the noise of normal activity.",
    playable: false,
  },
  {
    level: 3,
    label: "This is fine, everything is fine",
    blurb:
      "See!? This is why we can't have nice things. Attackers join that require the Engine to spot things that look normal in isolation but add up to a big pile of nasty.",
    playable: false,
  },
  {
    level: 4,
    label: "Awwww, hell no!",
    blurb:
      "Now stuff gets weird. Now stuff happens that causes sensor readings that should be impossible. I think it might be time to call the Ghostbusters!",
    playable: false,
  },
  {
    level: 5,
    label: "HEEEEEEEEEEELLLLLLLLP!",
    blurb:
      "Now this ain't fair!! There are insider threats and coordinated attacks. Oh, and of course like previously, all previous attackers are there, resulting in a total of 30 different types of attacks.",
    playable: false,
  },
];

/** Today's only playable hunt sits at chaos level 1 (see the chaos ladder above). */
const LIVE_SCENARIO_LEVEL: ChaosLevelNumber = 1;

/**
 * Build the UI's live-scenario view from a registry entry joined to its catalogue:
 * its name and tagline, at the fixed chaos-ladder level the one shipped hunt
 * occupies. Pure, so a caller builds it straight from `defaultEntry` with no React.
 */
export function liveScenarioFrom(entry: ScenarioRegistryEntry): LiveScenario {
  return {
    id: entry.id,
    displayName: entry.catalogue.name,
    tagline: entry.catalogue.flavor.tagline,
    level: LIVE_SCENARIO_LEVEL,
  };
}
